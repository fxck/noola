import type { FastifyInstance } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import {
  LoginInput, SignupInput, InviteInput, InviteLinkInput, MemberRoleInput, AcceptInviteInput, JoinLinkInput,
} from "@repo/contracts";
import { tenanted } from "../http/tenant.js";
import { workspaceSignupsEnabled, publicInstanceConfig } from "../instance-config.js";
import { withTenant, authPool } from "@repo/db";
import {
  auth as baAuth,
  betterAuthLogin, betterAuthLogout, betterAuthSignup,
  betterAuthTotpLogin, betterAuthEnable2fa, betterAuthConfirm2fa, betterAuthDisable2fa,
  createEmailInvite, cancelEmailInvite, changeMemberRole, removeMemberByUser,
  betterAuthAcceptInvite, betterAuthJoinViaLink,
} from "../betterauth.js";
import { listMembers, resolveMember } from "../members.js";
import {
  listAgentChannelIdentities, upsertAgentChannelIdentity, removeAgentChannelIdentity,
} from "../discord-classify.js";
import { listPendingInvites, getInvitePublic, createInviteLink, listInviteLinks, disableInviteLink, getLinkPublic } from "../invites.js";
import { recordAudit } from "../audit.js";

// better-auth's session/login payload carries identity (id/name/email/role) but NOT the app-owned
// avatar — that lives in the `users` roster row. So any place we hand the SPA a fresh user object
// (login, signup, invite/join accept) must fold the avatar in, or the header + profile render the
// initials fallback until the next /auth/me reload fills it. This is that fold, done once.
async function attachAvatar<T extends { id: string; tenantId: string }>(
  user: T,
): Promise<T & { avatarUrl: string | null }> {
  const avatarUrl = await withTenant(user.tenantId, async (c) => {
    const r = await c.query(`SELECT avatar_url FROM users WHERE id = $1`, [user.id]);
    return r.rowCount ? ((r.rows[0].avatar_url as string | null) ?? null) : null;
  }).catch(() => null);
  return { ...user, avatarUrl };
}

// Identity & membership surface: the app's own /auth/* endpoints (which delegate to better-auth),
// the self-gated better-auth catch-all mount (/ba/*), the team roster + invite management, and the
// public invite/join landing + accept (no prior session). better-auth is the sole auth authority;
// these routes are a thin app-facing adapter over it. /auth/* and /invite,/join lanes are PUBLIC
// (listed in server.ts's PUBLIC_ROUTES); the roster + invite mutations inherit the global RBAC gate.
export default async function authRoutes(app: FastifyInstance): Promise<void> {
  const webBase = (process.env.WEB_BASE_URL ?? "").replace(/\/+$/, "");

  // ---- Auth --------------------------------------------------------------
  app.post("/auth/login", async (req, reply) => {
    const parsed = LoginInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    // Authenticate through better-auth (scrypt bridge). Returns better-auth's response-BODY
    // session token + the public user; the SPA stores/sends it as Bearer.
    const out = await betterAuthLogin(parsed.data.email, parsed.data.password);
    if (!out) return reply.code(401).send({ error: "invalid credentials" });
    // 2FA-enrolled user: password was right but no session exists yet — the SPA shows the
    // code step and finishes on /auth/login/2fa with this opaque challenge.
    if ("twoFactor" in out) return { twoFactorRequired: true, challenge: out.challenge };
    return { token: out.token, user: await attachAvatar(out.user) };
  });

  // Step 2 of a 2FA sign-in: the challenge from /auth/login + the authenticator code.
  app.post("/auth/login/2fa", async (req, reply) => {
    const b = (req.body ?? {}) as Partial<{ challenge: string; code: string }>;
    if (!b.challenge || !b.code) return reply.code(400).send({ error: "challenge and code are required" });
    const out = await betterAuthTotpLogin(b.challenge, b.code.trim());
    if (!out) return reply.code(401).send({ error: "invalid or expired code" });
    return { token: out.token, user: await attachAvatar(out.user) };
  });

  // ---- TOTP 2FA management (session-scoped, password-gated where it matters) ----
  app.get("/auth/2fa", async (req, reply) => {
    const s = req.session;
    if (!s) return reply.code(401).send({ error: "unauthorized" });
    const r = await authPool.query(`SELECT "twoFactorEnabled" FROM "user" WHERE id = $1`, [s.userId]);
    return { enabled: r.rowCount ? Boolean(r.rows[0].twoFactorEnabled) : false };
  });

  app.post("/auth/2fa/enable", async (req, reply) => {
    if (!req.session) return reply.code(401).send({ error: "unauthorized" });
    const b = (req.body ?? {}) as Partial<{ password: string }>;
    if (!b.password) return reply.code(400).send({ error: "password is required" });
    const out = await betterAuthEnable2fa(req.headers, b.password);
    if (!out) return reply.code(400).send({ error: "wrong password" });
    return out; // { totpURI, backupCodes } — shown once, never stored client-side
  });

  app.post("/auth/2fa/confirm", async (req, reply) => {
    if (!req.session) return reply.code(401).send({ error: "unauthorized" });
    const b = (req.body ?? {}) as Partial<{ code: string }>;
    if (!b.code) return reply.code(400).send({ error: "code is required" });
    const out = await betterAuthConfirm2fa(req.headers, b.code.trim());
    if (!out) return reply.code(400).send({ error: "invalid code" });
    // Better-auth rotated the session on confirm — hand the SPA its replacement bearer.
    return { ok: true, token: out.token };
  });

  app.post("/auth/2fa/disable", async (req, reply) => {
    if (!req.session) return reply.code(401).send({ error: "unauthorized" });
    const b = (req.body ?? {}) as Partial<{ password: string }>;
    if (!b.password) return reply.code(400).send({ error: "password is required" });
    const ok = await betterAuthDisable2fa(req.headers, b.password);
    if (!ok) return reply.code(400).send({ error: "wrong password" });
    return { ok: true };
  });

  // Public instance shape (P2) — unauthenticated; the login page reads it to decide whether to
  // show the "Create a workspace" link and the demo-credentials hint. (/public/config is the
  // widget bootstrap — this is the INSTANCE config, hence the distinct path.)
  app.get("/public/instance", async () => publicInstanceConfig());

  // Self-serve sign-up: create an account AND its first workspace, then return the same
  // { token, user } login payload so the SPA lands signed-in with an active tenant. The org
  // creation fires the reverse projection (tenants + owner user). Single-org per identity today.
  app.post("/auth/signup", async (req, reply) => {
    // Self-hosted gate (P1): no new workspaces. Invites/login are untouched — better-auth's
    // native org-create is closed separately in betterauth.ts (allowUserToCreateOrganization).
    if (!workspaceSignupsEnabled()) {
      return reply.code(403).send({ error: "workspace signups are disabled" });
    }
    const parsed = SignupInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { email, password, name, orgName } = parsed.data;
    const out = await betterAuthSignup(email, password, name, orgName);
    if (!out.ok) return reply.code(out.status).send({ error: out.error });
    return reply.code(201).send({ token: out.token, user: await attachAvatar(out.user) });
  });

  app.get("/auth/me", async (req, reply) => {
    const s = req.session;
    if (!s) return reply.code(401).send({ error: "unauthorized" });
    const user = await attachAvatar({
      id: s.userId, tenantId: s.tenantId, email: s.email, name: s.name, role: s.role,
    });
    return { user };
  });

  // Update your own display name — the better-auth identity (what the session reads) + the app
  // roster row, so the header and the members list stay in sync.
  app.patch("/me/profile", async (req, reply) => {
    const s = req.session;
    if (!s) return reply.code(401).send({ error: "unauthorized" });
    const b = req.body as { name?: string; email?: string } | undefined;
    const name = b?.name?.trim();
    const email = b?.email ? b.email.trim().toLowerCase() : undefined;
    if (!name && !email) return reply.code(400).send({ error: "name or email is required" });
    if (email !== undefined && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return reply.code(400).send({ error: "invalid email" });
    }
    // better-auth is the auth authority. Update the display name through it (so its session payload
    // stays fresh); update the login email directly on its "user" row — email is only the lookup key,
    // the credential account is keyed by userId, so the password + active sessions survive the change.
    if (name) {
      try {
        await baAuth.api.updateUser({ body: { name }, headers: fromNodeHeaders(req.headers) });
      } catch {
        /* better-auth update failed — the app-row update below still applies */
      }
    }
    if (email) {
      try {
        await authPool.query(`UPDATE "user" SET email = $2, "updatedAt" = now() WHERE id = $1`, [s.userId, email]);
      } catch {
        return reply.code(409).send({ error: "That email is already in use." });
      }
    }
    // Mirror into the app users row (the request-path source of truth).
    await withTenant(s.tenantId, async (c) => {
      if (name) await c.query(`UPDATE users SET name = $2 WHERE id = $1`, [s.userId, name]);
      if (email) await c.query(`UPDATE users SET email = $2 WHERE id = $1`, [s.userId, email]);
    }).catch(() => {});
    return { ok: true, ...(name ? { name } : {}), ...(email ? { email } : {}) };
  });

  app.post("/auth/logout", async (req) => {
    // Revoke the better-auth session bound to the Bearer token (best-effort).
    await betterAuthLogout(req.headers);
    return { ok: true };
  });

  // ---- Password reset (public) ------------------------------------------
  // Request a reset: better-auth mints a token + emails the SPA link via sendResetPassword.
  // Always answer ok — never reveal whether the address has an account.
  app.post("/auth/forgot-password", async (req) => {
    const email = (req.body as { email?: string } | undefined)?.email;
    if (email && typeof email === "string") {
      try {
        await baAuth.api.requestPasswordReset({
          body: { email, redirectTo: `${webBase}/reset-password` },
        });
      } catch {
        /* swallow — no account-existence oracle */
      }
    }
    return { ok: true };
  });

  // Complete a reset: exchange the emailed token + a new password.
  app.post("/auth/reset-password", async (req, reply) => {
    const { token, password } = (req.body ?? {}) as { token?: string; password?: string };
    if (!token || !password) return reply.code(400).send({ error: "token and password are required" });
    if (password.length < 8) return reply.code(400).send({ error: "password must be at least 8 characters" });
    try {
      await baAuth.api.resetPassword({ body: { token, newPassword: password } });
      return { ok: true };
    } catch {
      return reply.code(400).send({ error: "invalid or expired reset link" });
    }
  });

  // ---- better-auth — mounted at /ba/*, self-gated (AUTHORITATIVE) --------
  // better-auth is the sole auth authority. This catch-all exposes its native endpoints
  // (sign-up, org management, invites, session listing, etc.); the app's own /auth/login,
  // /auth/logout and the request resolver all delegate to it. A Web Request is reconstructed
  // from the Fastify request; the body is re-stringified from the already-parsed object, so
  // there is no raw-body conflict with the Slack route's parser.
  app.route({
    method: ["GET", "POST"],
    url: "/ba/*",
    async handler(request, reply) {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const headers = fromNodeHeaders(request.headers);
      const webReq = new Request(url.toString(), {
        method: request.method,
        headers,
        ...(request.method !== "GET" && request.body ? { body: JSON.stringify(request.body) } : {}),
      });
      const response = await baAuth.handler(webReq);
      reply.status(response.status);
      response.headers.forEach((v: string, k: string) => reply.header(k, v));
      return reply.send(response.body ? await response.text() : null);
    },
  });

  // ---- Members & invites (Track A) ---------------------------------------
  // The team roster + invite management. The roster read is viewer+ (everyone sees teammates);
  // every mutation and the pending-invite/link listing are admin+ (the RBAC gate in rbac.ts).
  // Mutations forward the caller's Bearer to better-auth so ITS org access control double-gates.
  // Membership growth (accept/redeem) reverse-projects into the app `users` roster (projection.ts).

  // The org's member roster (member ⋈ user), enriched with the app-owned avatar (users.avatar_url,
  // same source attachAvatar reads) and the member's Discord teammate mark. viewer+ so any
  // authenticated member can see the team.
  app.get("/members", tenanted(async (tenantId) => {
    const [members, identities, avatars] = await Promise.all([
      listMembers(tenantId),
      listAgentChannelIdentities(tenantId, "discord").catch(() => []),
      withTenant(tenantId, async (c) =>
        (await c.query("SELECT id, avatar_url FROM users")).rows as Array<{ id: string; avatar_url: string | null }>,
      ).catch(() => []),
    ]);
    const discordIds = new Map(identities.map((i) => [i.userId, i.externalId]));
    const avatarUrls = new Map(avatars.map((a) => [a.id, a.avatar_url]));
    return {
      members: members.map((m) => ({
        ...m,
        avatarUrl: avatarUrls.get(m.userId) ?? m.image ?? null,
        discordId: discordIds.get(m.userId) ?? null,
      })),
    };
  }));

  // Link/unlink a member's Discord account (the explicit teammate mark — outranks role inference
  // in customer channels, unlocks reaction-triage "assign to me" in the ops-mirror forum).
  // :id is the app user id; empty/null discordId clears the mark. Admin+ via the global RBAC gate.
  app.put("/members/:id/discord", tenanted(async (tenantId, req, reply) => {
    const userId = (req.params as { id: string }).id;
    const raw = ((req.body ?? {}) as { discordId?: string | null }).discordId;
    const discordId = (raw ?? "").toString().trim();
    const member = await resolveMember(tenantId, userId);
    if (!member) return reply.code(404).send({ error: "not a member of this workspace" });
    if (!discordId) {
      await removeAgentChannelIdentity(tenantId, userId, "discord");
    } else {
      if (!/^\d{5,25}$/.test(discordId))
        return reply.code(400).send({ error: "Use the numeric Discord user ID (right-click the user in Discord → Copy User ID; enable Developer Mode in Discord settings if you don't see it)." });
      await upsertAgentChannelIdentity(tenantId, userId, discordId);
    }
    void recordAudit(tenantId, {
      actorId: req.session?.userId ?? null,
      actorName: req.session?.name ?? null,
      action: discordId ? "member.discord_linked" : "member.discord_unlinked",
      entityType: "member",
      entityId: userId,
      meta: discordId ? { discordId } : {},
    });
    return { ok: true, discordId: discordId || null };
  }));

  // Pending email invitations + active shareable links (admin).
  app.get("/members/invites", tenanted(async (tenantId) => {
    const [invites, links] = await Promise.all([listPendingInvites(tenantId), listInviteLinks(tenantId)]);
    return { invites, links };
  }));

  // Create + send an email invitation (admin).
  app.post("/members/invites", tenanted(async (tenantId, req, reply) => {
    const parsed = InviteInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const out = await createEmailInvite(req.headers.authorization ?? "", tenantId, parsed.data.email, parsed.data.role);
    if (!out.ok) return reply.code(out.status).send({ error: out.error });
    return reply.code(201).send({ invitation: out.invitation });
  }));

  // Cancel a pending email invitation (admin).
  app.delete("/members/invites/:id", tenanted(async (_tenantId, req, reply) => {
    const out = await cancelEmailInvite(req.headers.authorization ?? "", (req.params as { id: string }).id);
    if (!out.ok) return reply.code(400).send({ error: out.error });
    return { ok: true };
  }));

  // Mint a shareable invite link (admin). Returns the link row + its full shareable URL.
  app.post("/members/invite-links", tenanted(async (tenantId, req, reply) => {
    const userId = req.session?.userId;
    if (!userId) return reply.code(400).send({ error: "missing tenant" });
    const parsed = InviteLinkInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const link = await createInviteLink(tenantId, userId, parsed.data);
    return reply.code(201).send({ link, url: `${webBase}/join/${link.token}` });
  }));

  // Disable a shareable link (admin).
  app.delete("/members/invite-links/:token", tenanted(async (tenantId, req, reply) => {
    const gone = await disableInviteLink(tenantId, (req.params as { token: string }).token);
    if (!gone) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  }));

  // Change a member's role (admin). :id is the app user id; the last owner can't be demoted.
  app.patch("/members/:id/role", tenanted(async (tenantId, req, reply) => {
    const parsed = MemberRoleInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const out = await changeMemberRole(req.headers.authorization ?? "", tenantId, (req.params as { id: string }).id, parsed.data.role);
    if (!out.ok) return reply.code(out.status).send({ error: out.error });
    void recordAudit(tenantId, {
      actorId: req.session?.userId ?? null,
      actorName: req.session?.name ?? null,
      action: "member.role_changed",
      entityType: "member",
      entityId: (req.params as { id: string }).id,
      meta: { role: parsed.data.role },
    });
    return { ok: true };
  }));

  // Remove a member (admin). :id is the app user id; the last owner can't be removed.
  app.delete("/members/:id", tenanted(async (tenantId, req, reply) => {
    const out = await removeMemberByUser(req.headers.authorization ?? "", tenantId, (req.params as { id: string }).id);
    if (!out.ok) return reply.code(out.status).send({ error: out.error });
    return { ok: true };
  }));

  // ---- Public invite/join landing + accept (no prior session) ------------
  // The invitee/joiner has no session; accept/join authenticate (or create) the account
  // server-side, then join, then return the same { token, user } login payload.
  app.get("/invite/:id", async (req, reply) => {
    const inv = await getInvitePublic((req.params as { id: string }).id);
    if (!inv) return reply.code(404).send({ error: "invitation not found" });
    return { invite: { id: inv.id, email: inv.email, role: inv.role, status: inv.status, orgName: inv.orgName, inviterName: inv.inviterName } };
  });

  app.post("/invite/:id/accept", async (req, reply) => {
    const parsed = AcceptInviteInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const out = await betterAuthAcceptInvite((req.params as { id: string }).id, parsed.data.password, parsed.data.name ?? "");
    if (!out.ok) return reply.code(out.status).send({ error: out.error });
    return reply.code(201).send({ token: out.token, user: await attachAvatar(out.user) });
  });

  app.get("/join/:token", async (req, reply) => {
    const info = await getLinkPublic((req.params as { token: string }).token);
    if (!info) return reply.code(404).send({ error: "invite link not found" });
    return { link: info };
  });

  app.post("/join/:token", async (req, reply) => {
    const parsed = JoinLinkInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const out = await betterAuthJoinViaLink((req.params as { token: string }).token, parsed.data.email, parsed.data.password, parsed.data.name ?? "");
    if (!out.ok) return reply.code(out.status).send({ error: out.error });
    return reply.code(201).send({ token: out.token, user: await attachAvatar(out.user) });
  });
}
