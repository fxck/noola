import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { betterAuth } from "better-auth";
import { fromNodeHeaders } from "better-auth/node";
import { APIError } from "better-auth/api";
import { bearer, organization, twoFactor } from "better-auth/plugins";
import { sso } from "@better-auth/sso";
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements, adminAc } from "better-auth/plugins/organization/access";
import { authPool } from "@repo/db";
import { hashPassword, verifyPassword, type Session } from "./auth.js";
import { prodSecret } from "./prod-secret.js";
import { projectOrganization, projectMember, unprojectMember } from "./projection.js";
import { sendAuthEmail } from "./email.js";
import { resolveMember, countOwners } from "./members.js";
import { getInvitePublic, validateLink, redeemLinkMember } from "./invites.js";

// ── better-auth (Track A #2, DUAL-RUN) ───────────────────────────────────────
// Mounted at /ba/* alongside the legacy Valkey-token auth, which stays the AUTHORITATIVE
// gate. This proves better-auth can authenticate the seeded demo users (scrypt bridge +
// the migrate-time legacy→better-auth projection) WITHOUT touching the live auth path.
// The DB principal is the least-privilege `auth_user` (authPool) — DML only on the
// RLS-exempt identity tables, never the app tables.

// Custom org roles owner/admin/agent/viewer (maps studio's owner/admin/member). The keys
// become the strings stored in member.role; we gate on them in Fastify (requireRole),
// so the permission bodies stay minimal — owner/admin carry the built-in admin statements.
const ac = createAccessControl({ ...defaultStatements });
export const roles = {
  owner: ac.newRole({ ...adminAc.statements }),
  admin: ac.newRole({ ...adminAc.statements }),
  agent: ac.newRole({}),
  viewer: ac.newRole({}),
};

function baseURL(): string {
  const sub = process.env.zeropsSubdomain;
  if (sub) return /^https?:\/\//.test(sub) ? sub : `https://${sub}`;
  return `http://localhost:${process.env.PORT ?? 3000}`;
}

/** Where the SPA lives — invite/join links point here. Set WEB_BASE_URL per service so links
 *  land on the right web origin; falls back to the api base (functional, wrong host) if unset. */
function webBaseURL(): string {
  const w = process.env.WEB_BASE_URL;
  return w ? w.replace(/\/+$/, "") : baseURL();
}

// ── Single-org invariant (studio-auth-migration-plan §9.5, decision (a)) ───────
// One identity → one tenant, for now. The app `users` roster has a GLOBAL unique(email)
// (migration 0019), so projecting one person into a second tenant's `users` is impossible
// until multi-org is resolved (§9.5(b), deferred). Rather than let a second membership be
// created and then have the reverse projection fail with a 23505 AFTER the fact (leaving an
// orphaned better-auth member with no app row), we fail CLOSED in the org plugin's before-
// hooks: block the membership before it exists. throw-in-before-hook aborts the operation.
async function assertNoOtherOrg(userId: string, exceptOrgId?: string): Promise<void> {
  const r = await authPool.query(
    `SELECT 1 FROM "member" WHERE "userId" = $1 AND ($2::text IS NULL OR "organizationId" <> $2) LIMIT 1`,
    [userId, exceptOrgId ?? null],
  );
  if (r.rowCount) {
    throw new APIError("FORBIDDEN", {
      message: "This account already belongs to a workspace. Multi-workspace membership isn't supported yet.",
    });
  }
}

export const auth = betterAuth({
  database: authPool,
  basePath: "/ba",
  baseURL: baseURL(),
  secret: prodSecret("AUTH_SECRET", process.env.AUTH_SECRET, "dev-insecure-secret-change-me"),
  trustedOrigins: [baseURL()],
  // better-auth's tables are hand-written `id text` with no DB default → generate UUID-shaped
  // ids app-side so organization.id::uuid == the legacy tenant uuid holds (findings Q1).
  advanced: { database: { generateId: () => randomUUID() } },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    // Reuse our exact scrypt scheme so migrated account.password (= legacy password_hash)
    // verifies and demo1234 keeps working with no reset (findings Q2).
    password: {
      hash: (password: string) => hashPassword(password),
      verify: ({ password, hash }: { password: string; hash: string }) => verifyPassword(password, hash),
    },
    // Password reset: email a link to the SPA's /reset-password page carrying the token.
    // Rides the same Mailpit outbound seam as invites (sendAuthEmail no-ops when SMTP unset).
    sendResetPassword: async (data: { user: { email: string }; token: string }) => {
      const link = `${webBaseURL()}/reset-password?token=${data.token}`;
      await sendAuthEmail(
        data.user.email,
        "Reset your Noola password",
        `Someone requested a password reset for your Noola account.\n\n` +
          `Reset your password:\n${link}\n\n` +
          `This link expires soon. If you didn't request this, you can safely ignore this email.`,
      );
    },
  },
  // activeOrganizationId is NOT auto-set on sign-in (findings Q4) → pick the user's first
  // membership so a fresh session lands with a tenant. Read via authPool (auth_user is the
  // only role granted on "member"). Null → the resolver denies later; never a 'default'.
  databaseHooks: {
    session: {
      create: {
        before: async (session: { userId: string }) => {
          const r = await authPool.query(
            `SELECT "organizationId" FROM "member" WHERE "userId" = $1 ORDER BY "createdAt" LIMIT 1`,
            [session.userId],
          );
          return { data: { ...session, activeOrganizationId: r.rowCount ? r.rows[0].organizationId : null } };
        },
      },
    },
  },
  plugins: [
    bearer(),
    // TOTP 2FA (0092). Enable = password → totpURI + backup codes → verify-totp confirms
    // (flips user.twoFactorEnabled and ROTATES the session — the wrapper below hands the SPA
    // its new bearer). Sign-in for an enrolled user returns a signed `two_factor` challenge
    // cookie instead of a session; we relay it to the SPA as an opaque challenge string.
    twoFactor({ issuer: "Noola" }),
    organization({
      ac,
      roles,
      creatorRole: "owner",
      // Self-hosted gate (P1): with DISABLE_WORKSPACE_SIGNUP=1 the native org-create endpoint is
      // closed too — /auth/signup 403s upstream, and this stops a direct /ba/organization/create
      // from minting a workspace around that gate. Evaluated per-request so tests can flip the env.
      allowUserToCreateOrganization: async () => process.env.DISABLE_WORKSPACE_SIGNUP !== "1",
      // The app runs with emailAndPassword.requireEmailVerification:false (no verification flow
      // — email is trusted in dev/stage, and holding the invite/link IS the proof of address).
      // The org plugin gates invite-accept on verification SEPARATELY, so opt out here too, or a
      // freshly-created invitee account (emailVerified:false) can't accept.
      requireEmailVerificationOnInvitation: false,
      // Email invitations ride the shared outbound seam (Mailpit in dev/stage — memory
      // email-channel-mailpit). The link lands on the SPA's /invite/:id page; the invite id is
      // the capability and better-auth enforces the invited-email match on accept. sendAuthEmail
      // no-ops when SMTP is unset (the link is also returned via the API), so invites still work.
      sendInvitationEmail: async (data: { id: string; email: string; role: string; organization: { name: string } }) => {
        const link = `${webBaseURL()}/invite/${data.id}`;
        const org = data.organization?.name ?? "a workspace";
        await sendAuthEmail(
          data.email,
          `You're invited to ${org} on Noola`,
          `You've been invited to join ${org} as ${data.role} on Noola.\n\n` +
            `Accept your invitation:\n${link}\n\n` +
            `If you weren't expecting this, you can safely ignore this email.`,
        );
      },
      // ── Reverse identity projection + single-org enforcement ────────────────
      // better-auth writes organization/member/user through its own adapter (auth_user).
      // These hooks mirror each write into the app's tenant-scoped tenants/users tables via
      // app_user/withTenant (RLS-bound) — see projection.ts for the §9 design rationale
      // (Node projection, NOT auth_user-fired triggers). before-hooks enforce single-org
      // (§9.5). Projection errors propagate (fail loud on an identity-integrity gap); the
      // idempotent upserts + the single-org guard keep the happy path clean, and migrate.ts's
      // reverse backfill self-heals on the next deploy.
      organizationHooks: {
        // Block a second workspace for an identity that already has one (§9.5a).
        beforeCreateOrganization: async ({ user }: { user: { id: string } }) => {
          await assertNoOtherOrg(user.id);
        },
        beforeAddMember: async ({ member }: { member: { userId: string; organizationId: string } }) => {
          await assertNoOtherOrg(member.userId, member.organizationId);
        },
        beforeAcceptInvitation: async ({ user, organization: org }: { user: { id: string }; organization: { id: string } }) => {
          await assertNoOtherOrg(user.id, org.id);
        },
        // Project org + owner on create (afterCreateOrganization carries the creator member).
        afterCreateOrganization: async ({ organization: org, member, user }: HookOrgMemberUser) => {
          await projectOrganization(org);
          await projectMember(org.id, member.userId ?? user.id, user.email, user.name, member.role);
          // Always-on auto-tagging from the first ticket: seed the built-in tag rules + project the
          // managed 'autotag' automations for the new tenant (best-effort; boot backfill also retries).
          await import("./tagrules.js").then((m) => m.initTenantAutotag(org.id)).catch(() => {});
        },
        // Project any added / invited member into the tenant roster.
        afterAddMember: async ({ organization: org, member, user }: HookOrgMemberUser) => {
          await projectOrganization(org);
          await projectMember(org.id, member.userId ?? user.id, user.email, user.name, member.role);
        },
        afterAcceptInvitation: async ({ organization: org, member, user }: HookOrgMemberUser) => {
          await projectOrganization(org);
          await projectMember(org.id, member.userId ?? user.id, user.email, user.name, member.role);
        },
        // A role change re-projects the (mapped) role onto the roster row.
        afterUpdateMemberRole: async ({ organization: org, member, user }: HookOrgMemberUser) => {
          await projectMember(org.id, member.userId ?? user.id, user.email, user.name, member.role);
        },
        // Removal drops the roster row; the assignee FK is ON DELETE SET NULL.
        afterRemoveMember: async ({ organization: org, member }: { organization: { id: string }; member: { userId: string } }) => {
          await unprojectMember(org.id, member.userId);
        },
      },
    }),
    // ── Enterprise SSO (OIDC + SAML), first-party plugin ────────────────────
    // The plugin owns the security-critical machinery: OIDC discovery + code exchange, JWKS
    // signature verification, SAML, and session creation. Provider configs live in its own
    // `ssoProvider` table (migration 0045), each pinned to an `organizationId` (== our tenant).
    //
    // We DON'T use its `organizationProvisioning`: that adds the member via a raw adapter.create
    // which bypasses our organizationHooks (no single-org guard, no reverse projection) AND runs
    // after the session is created (so activeOrganizationId would be null → our resolver denies).
    // Instead we own membership in `provisionUser` (fires before the session cookie is set):
    // enforce the single-org invariant, ensure the membership, reverse-project the app users row,
    // and stamp activeOrganizationId onto the just-created session so resolveBetterAuthSession
    // lands a real tenant. Idempotent + on-every-login so profile/role stay in sync.
    sso({
      provisionUserOnEveryLogin: true,
      organizationProvisioning: { disabled: true },
      provisionUser: async ({ user, provider }: {
        user: { id: string; email?: string | null; name?: string | null };
        provider: { organizationId?: string | null };
      }) => {
        const orgId = provider.organizationId;
        if (!orgId || !user.email) return; // no org / no email → can't place the user; leave unprovisioned.
        const email = user.email;
        const name = user.name ?? email;
        // Single-org invariant (§9.5): refuse an identity that already belongs to another workspace.
        await assertNoOtherOrg(user.id, orgId);
        // Ensure the better-auth membership; keep an existing role, default new SSO users to agent.
        const existing = await authPool.query(
          `SELECT "role" FROM "member" WHERE "organizationId" = $1 AND "userId" = $2 LIMIT 1`,
          [orgId, user.id],
        );
        const role: string = existing.rowCount ? (existing.rows[0].role as string) : "agent";
        if (!existing.rowCount) {
          await authPool.query(
            `INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt")
             VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`,
            [randomUUID(), orgId, user.id, role],
          );
        }
        // Reverse-project into the app tenant roster (global unique(email) enforces single-org app-side).
        await projectMember(orgId, user.id, email, name, role);
        // Stamp the active org onto this user's session(s): the plugin created the session moments
        // ago (before this hook) with a null active org for a brand-new user, and our resolver reads
        // the stored activeOrganizationId. A single-org user's sessions always resolve to their org.
        await authPool.query(
          `UPDATE "session" SET "activeOrganizationId" = $1
            WHERE "userId" = $2 AND "activeOrganizationId" IS DISTINCT FROM $1`,
          [orgId, user.id],
        );
      },
    }),
  ],
});

// Shared payload shape for the member-carrying org hooks (subset of better-auth's types we use).
type HookOrgMemberUser = {
  organization: { id: string; name: string };
  member: { userId: string; role: string };
  user: { id: string; email: string; name: string };
};

// ── Authoritative request resolver (Track A #2, Slice 3 — THE FLIP) ──────────
// better-auth is now the SOLE auth authority. Resolve the request's Bearer token to the
// app's Session shape by asking better-auth's server API (the bearer plugin reads the
// Authorization header; per findings Q6 the sign-in response-BODY token verifies here).
//
// The identity math that makes this a drop-in for the legacy resolver:
//   • better-auth user.id  == app users.id  (projection wrote id::text) → assignment FKs hold
//   • activeOrganizationId == tenants.id    (organization.id = tenants.id::text) → RLS's
//     app.tenant_id GUC is satisfied unchanged; withTenant()/tenantOf() call sites untouched
//   • role comes from the org-scoped member row (owner/admin/agent/viewer)
//
// Deny a session with no active organization (never a 'default' tenant) and fail closed on
// any better-auth/DB error → null → the global gate 401s. No legacy Valkey fallback exists.
export async function resolveBetterAuthSession(headers: IncomingHttpHeaders): Promise<Session | null> {
  try {
    const res = await auth.api.getSession({ headers: fromNodeHeaders(headers) });
    if (!res?.session || !res.user) return null;
    const orgId = (res.session as { activeOrganizationId?: string | null }).activeOrganizationId;
    if (!orgId) return null;
    const r = await authPool.query(
      `SELECT role FROM "member" WHERE "organizationId" = $1 AND "userId" = $2 LIMIT 1`,
      [orgId, res.user.id],
    );
    const role = r.rowCount ? (r.rows[0].role as string) : "viewer";
    return {
      userId: res.user.id,
      tenantId: orgId,
      role,
      email: res.user.email,
      name: res.user.name ?? "",
    };
  } catch {
    return null;
  }
}

/**
 * Sign in through better-auth (scrypt bridge) and return the app's public login payload.
 * The token is better-auth's session token from the response BODY (findings Q6) — the SPA
 * stores it and sends it as `Authorization: Bearer`, exactly as it did the legacy token, so
 * the client surface is unchanged. Returns null on bad credentials (no enumeration signal).
 */
/** Pull one Set-Cookie pair (name=value) whose name contains `needle` — used to relay the
 *  2FA challenge cookie and to recover the rotated session after an enable-confirm. */
function setCookiePair(headers: Headers, needle: string): string | null {
  const all = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  for (const line of all) {
    const pair = line.split(";")[0]?.trim();
    if (pair && pair.split("=")[0]?.includes(needle)) return pair;
  }
  return null;
}

export type LoginOutcome =
  | { token: string; user: { id: string; tenantId: string; email: string; name: string; role: string } }
  | { twoFactor: true; challenge: string };

export async function betterAuthLogin(
  email: string,
  password: string,
): Promise<LoginOutcome | null> {
  let token: string | undefined;
  try {
    const { headers, response } = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
    if ((response as { twoFactorRedirect?: boolean }).twoFactorRedirect) {
      // 2FA pending: no session yet. The signed challenge cookie identifies the pending user
      // for verify-totp; relayed opaquely — the SPA never parses it.
      const challenge = setCookiePair(headers, "two_factor");
      return challenge ? { twoFactor: true, challenge } : null;
    }
    token = (response as { token?: string }).token;
  } catch {
    return null; // APIError on invalid credentials
  }
  if (!token) return null;
  const session = await resolveBetterAuthSession({ authorization: `Bearer ${token}` } as IncomingHttpHeaders);
  if (!session) return null;
  return {
    token,
    user: { id: session.userId, tenantId: session.tenantId, email: session.email, name: session.name, role: session.role },
  };
}

/** Complete a 2FA sign-in: the opaque challenge (the signed two_factor cookie pair) plus the
 *  TOTP code → a real session, same payload as betterAuthLogin. Null on a bad/expired code. */
export async function betterAuthTotpLogin(
  challenge: string,
  code: string,
): Promise<{ token: string; user: { id: string; tenantId: string; email: string; name: string; role: string } } | null> {
  let token: string | undefined;
  try {
    const res = await auth.api.verifyTOTP({ body: { code }, headers: new Headers({ cookie: challenge }) });
    token = (res as { token?: string }).token;
  } catch {
    return null;
  }
  if (!token) return null;
  const session = await resolveBetterAuthSession({ authorization: `Bearer ${token}` } as IncomingHttpHeaders);
  if (!session) return null;
  return {
    token,
    user: { id: session.userId, tenantId: session.tenantId, email: session.email, name: session.name, role: session.role },
  };
}

/** Begin 2FA enrollment (password-gated): returns the otpauth totpURI (QR payload) + backup
 *  codes. twoFactorEnabled stays false until the confirm step verifies a code. */
export async function betterAuthEnable2fa(
  headers: IncomingHttpHeaders,
  password: string,
): Promise<{ totpURI: string; backupCodes: string[] } | null> {
  try {
    const res = await auth.api.enableTwoFactor({ body: { password }, headers: fromNodeHeaders(headers) });
    const out = res as { totpURI?: string; backupCodes?: string[] };
    return out.totpURI ? { totpURI: out.totpURI, backupCodes: out.backupCodes ?? [] } : null;
  } catch {
    return null;
  }
}

/** Confirm enrollment with the first TOTP code. Better-auth flips twoFactorEnabled AND rotates
 *  the session (the old bearer dies) — the new session token is recovered from the response
 *  cookie and returned so the SPA can swap its bearer. */
export async function betterAuthConfirm2fa(
  headers: IncomingHttpHeaders,
  code: string,
): Promise<{ token: string | null } | null> {
  try {
    const { headers: resHeaders } = await auth.api.verifyTOTP({
      body: { code },
      headers: fromNodeHeaders(headers),
      returnHeaders: true,
    });
    const pair = setCookiePair(resHeaders, "session_token");
    if (!pair) return { token: null };
    // Signed cookie value = `${token}.${signature}` (the token itself never contains a dot).
    const raw = decodeURIComponent(pair.slice(pair.indexOf("=") + 1));
    return { token: raw.split(".")[0] || null };
  } catch {
    return null;
  }
}

/** Disable 2FA (password-gated). */
export async function betterAuthDisable2fa(
  headers: IncomingHttpHeaders,
  password: string,
): Promise<boolean> {
  try {
    await auth.api.disableTwoFactor({ body: { password }, headers: fromNodeHeaders(headers) });
    return true;
  } catch {
    return false;
  }
}

/** Revoke the caller's better-auth session (Bearer token in the headers). Best-effort. */
export async function betterAuthLogout(headers: IncomingHttpHeaders): Promise<void> {
  try {
    await auth.api.signOut({ headers: fromNodeHeaders(headers) });
  } catch {
    /* best-effort — the client clears its token regardless */
  }
}

export type SignupResult =
  | { ok: true; token: string; user: { id: string; tenantId: string; email: string; name: string; role: string } }
  | { ok: false; status: number; error: string };

/**
 * Sign up a new user AND bootstrap their first workspace in one server-side flow, returning the
 * app's login payload — the SPA stores the token and is immediately signed in with an active
 * tenant, exactly like login. Steps:
 *   1. create the credential account (scrypt bridge; auto-signs-in → body token, findings Q6),
 *   2. create the org — the creator becomes `owner`, which fires the org hooks that project the
 *      new tenant + owner into the app tenants/users tables (projection.ts),
 *   3. set that org active on the just-minted session (it was null at sign-up: the session was
 *      created before any membership existed, so the session hook left activeOrganizationId null),
 *   4. resolve the now-complete session into the public user shape.
 * Single-org today: the org before-hooks refuse a second workspace per identity (§9.5a). The
 * result is discriminated so the route maps "email already registered" → 409.
 */
export async function betterAuthSignup(
  email: string,
  password: string,
  name: string,
  orgName: string,
): Promise<SignupResult> {
  // 1) credential account. autoSignIn (default) returns the session token in the body.
  let token: string | undefined;
  try {
    const res = await auth.api.signUpEmail({ body: { name, email, password } });
    token = (res as { token?: string }).token ?? undefined;
  } catch (e) {
    const msg = (e as { message?: string }).message ?? "sign-up failed";
    const status = (e as { statusCode?: number }).statusCode ?? 400;
    // Duplicate email is the expected 4xx — surface it as 409 so the client can say so.
    return { ok: false, status: status === 422 || /exist|taken|already|registered/i.test(msg) ? 409 : 400, error: msg };
  }
  // Fall back to an explicit sign-in if autoSignIn is disabled (no token returned).
  if (!token) {
    try {
      token = ((await auth.api.signInEmail({ body: { email, password } })) as { token?: string }).token;
    } catch {
      /* handled by the guard below */
    }
  }
  if (!token) return { ok: false, status: 500, error: "could not establish a session" };
  const hdrs = { authorization: `Bearer ${token}` } as IncomingHttpHeaders;

  // 2) first workspace. Creator → owner; the org hooks project tenants + users. Slug carries a
  //    random suffix so distinct workspaces of the same name don't collide (§9.6).
  let orgId: string | undefined;
  try {
    const slugBase =
      orgName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "workspace";
    const org = await auth.api.createOrganization({
      body: { name: orgName, slug: `${slugBase}-${randomUUID().slice(0, 8)}`, keepCurrentActiveOrganization: false },
      headers: hdrs,
    });
    orgId = (org as { id?: string } | null)?.id;
  } catch (e) {
    const msg = (e as { message?: string }).message ?? "workspace creation failed";
    // The single-org before-hook throws FORBIDDEN for an identity that already has a workspace.
    return { ok: false, status: /forbidden|already belongs/i.test(msg) ? 409 : /slug/i.test(msg) ? 409 : 400, error: msg };
  }
  if (!orgId) return { ok: false, status: 500, error: "workspace creation returned no id" };

  // 3) make it the active org on this session (belt-and-suspenders; createOrganization with
  //    keepCurrentActiveOrganization:false already sets it, but resolve re-checks).
  try {
    await auth.api.setActiveOrganization({ body: { organizationId: orgId }, headers: hdrs });
  } catch {
    /* resolve below is the source of truth */
  }

  // 4) resolve into the app payload (role should be 'owner').
  const session = await resolveBetterAuthSession(hdrs);
  if (!session) return { ok: false, status: 500, error: "session resolved without an active workspace" };
  return {
    ok: true,
    token,
    user: { id: session.userId, tenantId: session.tenantId, email: session.email, name: session.name, role: session.role },
  };
}

// ── Member + invite management (owner/admin, gated at the route) ─────────────
// All of these forward the ACTING admin's Bearer to auth.api, so better-auth's own org access
// control (owner/admin carry adminAc.statements) double-gates alongside the app RBAC floor.

const asHeaders = (authorization: string) => ({ authorization }) as unknown as Headers;

/** Create an email invitation (fires sendInvitationEmail → Mailpit). Role is the validated
 *  invite enum (owner is never invitable). */
export async function createEmailInvite(
  authorization: string,
  orgId: string,
  email: string,
  role: "admin" | "agent" | "viewer",
): Promise<{ ok: true; invitation: { id: string; email: string; role: string; status: string } } | { ok: false; status: number; error: string }> {
  try {
    const inv = (await auth.api.createInvitation({
      body: { email, role, organizationId: orgId },
      headers: asHeaders(authorization),
    })) as { id: string; email: string; role: string; status: string };
    return { ok: true, invitation: { id: inv.id, email: inv.email, role: inv.role, status: inv.status } };
  } catch (e) {
    const msg = (e as { message?: string }).message ?? "invite failed";
    const status = (e as { statusCode?: number }).statusCode ?? 400;
    return { ok: false, status: /already|member|exist/i.test(msg) ? 409 : status, error: msg };
  }
}

/** Cancel a pending email invitation. */
export async function cancelEmailInvite(authorization: string, invitationId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await auth.api.cancelInvitation({ body: { invitationId }, headers: asHeaders(authorization) });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as { message?: string }).message ?? "cancel failed" };
  }
}

/** Change a member's role. Guards the last owner; the afterUpdateMemberRole hook re-projects
 *  the (mapped) role into the app roster. `userId` is the app user id (member is resolved here). */
export async function changeMemberRole(
  authorization: string,
  orgId: string,
  userId: string,
  role: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const m = await resolveMember(orgId, userId);
  if (!m) return { ok: false, status: 404, error: "member not found" };
  if (m.role === "owner" && role !== "owner" && (await countOwners(orgId)) <= 1) {
    return { ok: false, status: 400, error: "cannot demote the last owner" };
  }
  try {
    await auth.api.updateMemberRole({
      body: { memberId: m.memberId, role, organizationId: orgId },
      headers: asHeaders(authorization),
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, status: (e as { statusCode?: number }).statusCode ?? 400, error: (e as { message?: string }).message ?? "role change failed" };
  }
}

/** Remove a member. Guards the last owner; the afterRemoveMember hook unprojects the roster row
 *  (their assigned tickets fall to unassigned via ON DELETE SET NULL). */
export async function removeMemberByUser(
  authorization: string,
  orgId: string,
  userId: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const m = await resolveMember(orgId, userId);
  if (!m) return { ok: false, status: 404, error: "member not found" };
  if (m.role === "owner" && (await countOwners(orgId)) <= 1) {
    return { ok: false, status: 400, error: "cannot remove the last owner" };
  }
  try {
    await auth.api.removeMember({
      body: { memberIdOrEmail: m.memberId, organizationId: orgId },
      headers: asHeaders(authorization),
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, status: (e as { statusCode?: number }).statusCode ?? 400, error: (e as { message?: string }).message ?? "remove failed" };
  }
}

// ── Public join flows (invitee/joiner has no session yet) ────────────────────
// Both create-or-authenticate the account server-side then join, so the SPA needs no
// better-auth client. The single-org invariant is enforced in the org before-hook (email path)
// or in redeemLinkMember (link path). Returns the same { token, user } payload as login.

/** Get a session token for `email`: sign in an existing account with the supplied password, or
 *  sign up a NEW account (credential only — NO workspace, so it can then join the inviter's). */
async function accountTokenFor(email: string, password: string, name: string): Promise<string | undefined> {
  const exists = await authPool.query(`SELECT 1 FROM "user" WHERE email = $1 LIMIT 1`, [email]);
  try {
    const res = exists.rowCount
      ? await auth.api.signInEmail({ body: { email, password } })
      : await auth.api.signUpEmail({ body: { name: name || email, email, password } });
    return (res as { token?: string }).token ?? undefined;
  } catch {
    return undefined;
  }
}

/** Accept an email invitation: authenticate (or create) the invited account, accept, activate
 *  the org, resolve. The invited-email match is enforced by better-auth's acceptInvitation. */
export async function betterAuthAcceptInvite(invitationId: string, password: string, name: string): Promise<SignupResult> {
  const inv = await getInvitePublic(invitationId);
  if (!inv) return { ok: false, status: 404, error: "invitation not found" };
  if (inv.status !== "pending") return { ok: false, status: 410, error: "invitation is no longer valid" };
  const token = await accountTokenFor(inv.email, password, name);
  if (!token) return { ok: false, status: 401, error: "could not authenticate — check the password" };
  const hdrs = { authorization: `Bearer ${token}` } as IncomingHttpHeaders;
  try {
    await auth.api.acceptInvitation({ body: { invitationId }, headers: asHeaders(`Bearer ${token}`) });
  } catch (e) {
    const msg = (e as { message?: string }).message ?? "accept failed";
    return { ok: false, status: /forbidden|already belongs/i.test(msg) ? 409 : 400, error: msg };
  }
  try {
    await auth.api.setActiveOrganization({ body: { organizationId: inv.organizationId }, headers: asHeaders(`Bearer ${token}`) });
  } catch {
    /* resolve re-checks */
  }
  const session = await resolveBetterAuthSession(hdrs);
  if (!session) return { ok: false, status: 500, error: "joined but no active workspace resolved" };
  return { ok: true, token, user: { id: session.userId, tenantId: session.tenantId, email: session.email, name: session.name, role: session.role } };
}

/** Redeem a shareable invite link: validate → authenticate (or create) the account → add the
 *  member (direct write + explicit projection, redeemLinkMember) → activate → resolve. */
export async function betterAuthJoinViaLink(token: string, email: string, password: string, name: string): Promise<SignupResult> {
  const v = await validateLink(token, email);
  if (!v.ok) {
    const status = v.reason === "not-found" ? 404 : v.reason === "domain" ? 403 : 410;
    return { ok: false, status, error: `invite link ${v.reason}` };
  }
  const sessToken = await accountTokenFor(email, password, name);
  if (!sessToken) return { ok: false, status: 401, error: "could not authenticate — check the password" };
  const hdrs = { authorization: `Bearer ${sessToken}` } as IncomingHttpHeaders;
  const who = await auth.api.getSession({ headers: fromNodeHeaders(hdrs) });
  const userId = who?.user?.id;
  if (!userId) return { ok: false, status: 500, error: "no user for the session" };
  const red = await redeemLinkMember(token, v.orgId, userId, email, name, v.role);
  if (!red.ok) {
    return red.reason === "multi-org"
      ? { ok: false, status: 409, error: "this account already belongs to a workspace" }
      : { ok: false, status: 400, error: "could not join the workspace" };
  }
  try {
    await auth.api.setActiveOrganization({ body: { organizationId: v.orgId }, headers: asHeaders(`Bearer ${sessToken}`) });
  } catch {
    /* resolve re-checks */
  }
  const session = await resolveBetterAuthSession(hdrs);
  if (!session) return { ok: false, status: 500, error: "joined but no active workspace resolved" };
  return { ok: true, token: sessToken, user: { id: session.userId, tenantId: session.tenantId, email: session.email, name: session.name, role: session.role } };
}

// ── Enterprise SSO wrappers (plugin-backed) ─────────────────────────────────
// Thin server-side plumbing over the @better-auth/sso plugin. The plugin owns storage
// (`ssoProvider` table), the OIDC/SAML machinery, and sessions; these functions adapt our
// admin REST shape ({name/emailDomain/issuer/authorizeUrl/tokenUrl/clientId/clientSecret})
// to the plugin's provider model and drive sign-in. Providers are pinned to the caller's org
// (organizationId == tenantId), so the login-time provisionUser hook can place the user.

export interface SsoConnectionView {
  id: string;            // == providerId
  provider: "oidc" | "saml";
  name: string;
  email_domain: string;
  issuer: string | null;
  authorize_url: string | null;
  token_url: string | null;
  jwks_url: string | null;
  client_id: string | null;
  has_secret: boolean;
  enabled: boolean;
  created_at: string;
}

interface SsoAdminInput {
  name?: string;
  emailDomain?: string;
  issuer?: string | null;
  authorizeUrl?: string | null;
  tokenUrl?: string | null;
  jwksUrl?: string | null;
  clientId?: string | null;
  clientSecret?: string | null;
}

function slugId(name: string, domain: string): string {
  const base = (name || domain || "sso").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return `${base || "sso"}-${randomUUID().slice(0, 8)}`;
}

// The plugin serializes oidcConfig to a JSON string in ssoProvider.oidcConfig; read it back to
// synthesize our admin view + to merge on update (write-only secret preservation).
function parseOidc(raw: string | null): Record<string, any> {
  if (!raw) return {};
  try { return JSON.parse(raw) as Record<string, any>; } catch { return {}; }
}

function toView(row: { providerId: string; issuer: string | null; domain: string; oidcConfig: string | null; samlConfig: string | null; createdAt?: Date | string | null }): SsoConnectionView {
  const oidc = parseOidc(row.oidcConfig);
  return {
    id: row.providerId,
    provider: row.samlConfig ? "saml" : "oidc",
    name: row.domain,
    email_domain: row.domain,
    issuer: row.issuer ?? oidc.issuer ?? null,
    authorize_url: oidc.authorizationEndpoint ?? null,
    token_url: oidc.tokenEndpoint ?? null,
    jwks_url: oidc.jwksEndpoint ?? null,
    client_id: oidc.clientId ?? null,
    has_secret: !!oidc.clientSecret,
    enabled: true, // provider existence == enabled (no separate flag in the plugin model)
    created_at: (row.createdAt instanceof Date ? row.createdAt.toISOString() : (row.createdAt ?? new Date(0).toISOString())) as string,
  };
}

/** List a tenant's SSO providers (queried straight from the plugin table — the plugin's list
 *  endpoint only returns personal, org-less providers, so it can't serve org-linked ones). */
export async function listSso(orgId: string): Promise<SsoConnectionView[]> {
  const r = await authPool.query(
    `SELECT "providerId", "issuer", "domain", "oidcConfig", "samlConfig", "createdAt"
       FROM "ssoProvider" WHERE "organizationId" = $1 ORDER BY "createdAt" ASC NULLS LAST`,
    [orgId],
  );
  return (r.rows as any[]).map(toView);
}

/** Register a new OIDC provider for the tenant. Forwards the admin's Bearer so the plugin scopes
 *  the write to their session, and pins organizationId so login-time provisioning can place users. */
export async function createSso(
  authorization: string,
  orgId: string,
  input: SsoAdminInput,
): Promise<{ ok: true; connection: SsoConnectionView } | { ok: false; status: number; error: string }> {
  const domain = (input.emailDomain ?? "").trim().toLowerCase().replace(/^@+/, "");
  if (!domain) return { ok: false, status: 400, error: "email domain is required" };
  if (!input.clientId) return { ok: false, status: 400, error: "client id is required" };
  const providerId = slugId(input.name ?? "", domain);
  const issuer = input.issuer || input.authorizeUrl || `https://${domain}`;
  try {
    await auth.api.registerSSOProvider({
      body: {
        providerId,
        issuer,
        domain,
        organizationId: orgId,
        oidcConfig: {
          clientId: input.clientId,
          clientSecret: input.clientSecret ?? "",
          ...(input.authorizeUrl ? { authorizationEndpoint: input.authorizeUrl } : {}),
          ...(input.tokenUrl ? { tokenEndpoint: input.tokenUrl } : {}),
          ...(input.jwksUrl ? { jwksEndpoint: input.jwksUrl } : {}),
          // All three endpoints supplied → skip runtime OIDC discovery (avoids the discovery-origin
          // trust check; the plugin still SSRF-guards each endpoint by public-routability).
          ...(input.authorizeUrl && input.tokenUrl && input.jwksUrl ? { skipDiscovery: true } : {}),
          scopes: ["openid", "email", "profile"],
        },
      },
      headers: asHeaders(authorization),
    });
  } catch (e) {
    const msg = (e as { message?: string }).message ?? "registration failed";
    const status = (e as { statusCode?: number }).statusCode ?? 400;
    return { ok: false, status: /exist|taken|already/i.test(msg) ? 409 : status, error: msg };
  }
  const list = await listSso(orgId);
  const connection = list.find((c) => c.id === providerId);
  return connection ? { ok: true, connection } : { ok: false, status: 500, error: "registered but could not read back" };
}

/** Update a provider's editable fields. Reads the stored oidcConfig and merges the patch so an
 *  omitted client secret is preserved (write-only). Verifies tenant ownership first. */
export async function updateSso(
  authorization: string,
  orgId: string,
  providerId: string,
  patch: SsoAdminInput,
): Promise<{ ok: true; connection: SsoConnectionView } | { ok: false; status: number; error: string }> {
  const cur = await authPool.query(
    `SELECT "issuer", "domain", "oidcConfig" FROM "ssoProvider" WHERE "providerId" = $1 AND "organizationId" = $2 LIMIT 1`,
    [providerId, orgId],
  );
  if (!cur.rowCount) return { ok: false, status: 404, error: "not found" };
  const row = cur.rows[0] as { issuer: string | null; domain: string; oidcConfig: string | null };
  const oidc = parseOidc(row.oidcConfig);
  delete oidc.issuer; // issuer is a top-level provider field, not part of oidcConfig
  const domain = patch.emailDomain !== undefined ? patch.emailDomain.trim().toLowerCase().replace(/^@+/, "") : row.domain;
  const issuer = patch.issuer ?? row.issuer ?? undefined;
  const mergedOidc: Record<string, unknown> = {
    ...oidc,
    ...(patch.clientId ? { clientId: patch.clientId } : {}),
    ...(patch.clientSecret ? { clientSecret: patch.clientSecret } : {}),
    ...(patch.authorizeUrl ? { authorizationEndpoint: patch.authorizeUrl } : {}),
    ...(patch.tokenUrl ? { tokenEndpoint: patch.tokenUrl } : {}),
    ...(patch.jwksUrl ? { jwksEndpoint: patch.jwksUrl } : {}),
  };
  // Skip discovery iff the merged config carries all three endpoints (see createSso).
  mergedOidc.skipDiscovery =
    !!mergedOidc.authorizationEndpoint && !!mergedOidc.tokenEndpoint && !!mergedOidc.jwksEndpoint;
  try {
    await auth.api.updateSSOProvider({
      // updateSSOProvider re-links nothing — the provider stays on its org (verified above).
      body: { providerId, issuer, domain, oidcConfig: mergedOidc as Record<string, never> },
      headers: asHeaders(authorization),
    });
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode ?? 400;
    return { ok: false, status, error: (e as { message?: string }).message ?? "update failed" };
  }
  const connection = (await listSso(orgId)).find((c) => c.id === providerId);
  return connection ? { ok: true, connection } : { ok: false, status: 404, error: "not found" };
}

/** Delete a provider after verifying it belongs to the tenant. */
export async function deleteSso(authorization: string, orgId: string, providerId: string): Promise<boolean> {
  const owned = await authPool.query(
    `SELECT 1 FROM "ssoProvider" WHERE "providerId" = $1 AND "organizationId" = $2 LIMIT 1`,
    [providerId, orgId],
  );
  if (!owned.rowCount) return false;
  try {
    await auth.api.deleteSSOProvider({ body: { providerId }, headers: asHeaders(authorization) });
    return true;
  } catch {
    return false;
  }
}

/** Public discovery: does this email's domain have an SSO provider? Drives the login page's button. */
export async function discoverSsoByEmail(email: string): Promise<{ sso: boolean; providerId?: string; name?: string; provider?: string }> {
  const at = email.indexOf("@");
  if (at < 0) return { sso: false };
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain) return { sso: false };
  const r = await authPool.query(
    `SELECT "providerId", "domain", "samlConfig" FROM "ssoProvider" WHERE lower("domain") = $1 LIMIT 1`,
    [domain],
  );
  if (!r.rowCount) return { sso: false };
  const row = r.rows[0] as { providerId: string; domain: string; samlConfig: string | null };
  return { sso: true, providerId: row.providerId, name: row.domain, provider: row.samlConfig ? "saml" : "oidc" };
}

/** Begin the IdP handoff: ask the plugin for the authorize redirect. `callbackURL` is where the
 *  plugin sends the browser AFTER its own /ba/sso/callback establishes the session — we point it at
 *  our same-origin /public/sso/complete bridge (below) which reads the session and hands the SPA a
 *  Bearer token. Returns the IdP URL to 302 to. */
export async function startSso(
  providerIdOrEmail: { providerId?: string; email?: string },
  callbackURL: string,
  errorCallbackURL: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  try {
    const res = (await auth.api.signInSSO({
      body: { ...providerIdOrEmail, callbackURL, errorCallbackURL },
    })) as { url?: string; redirect?: boolean };
    if (!res?.url) return { ok: false, error: "the provider could not start a sign-in" };
    return { ok: true, url: res.url };
  } catch (e) {
    return { ok: false, error: (e as { message?: string }).message ?? "SSO sign-in failed to start" };
  }
}

/** The Bearer bridge: after the plugin's callback set a session cookie (same api origin), resolve
 *  it to the raw session token the SPA stores. Returns null if no valid session is present. */
export async function ssoSessionToken(headers: IncomingHttpHeaders): Promise<string | null> {
  try {
    const res = await auth.api.getSession({ headers: fromNodeHeaders(headers) });
    const token = (res?.session as { token?: string } | undefined)?.token;
    return token ?? null;
  } catch {
    return null;
  }
}
