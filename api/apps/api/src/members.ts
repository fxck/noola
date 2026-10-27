import { authPool } from "@repo/db";

// Member roster reads over the better-auth identity tables (organization/member/user), scoped
// to one org. These are RLS-EXEMPT tables reachable only by auth_user (authPool) — the app's
// tenant `users` roster is the PROJECTION of this (kept in sync by projection.ts); the members
// admin surface reads the authoritative side directly so a role change shows immediately. No
// `auth` import here (pure DB) → betterauth.ts can depend on this without a cycle.

export interface MemberRow {
  userId: string;
  email: string;
  name: string;
  role: string;
  createdAt: string;
  /** Avatar URL/path from the auth `user.image` (profile upload); null when unset. */
  image: string | null;
  /** Whether the member has confirmed TOTP 2FA (0092) — surfaced on the roster for admins. */
  twoFactorEnabled: boolean;
}

/** The org's members (member ⋈ user), earliest first. Org-scoped by organizationId — the
 *  caller passes its own session tenantId, so this only ever returns one tenant's roster. */
export async function listMembers(orgId: string): Promise<MemberRow[]> {
  const r = await authPool.query(
    `SELECT m."userId", u.email, u.name, u.image, u."twoFactorEnabled", m.role, m."createdAt"
       FROM "member" m JOIN "user" u ON u.id = m."userId"
      WHERE m."organizationId" = $1
      ORDER BY m."createdAt" ASC, m.id ASC`,
    [orgId],
  );
  return r.rows.map((x) => ({
    userId: x.userId,
    email: x.email,
    name: x.name,
    role: x.role,
    createdAt: x.createdAt,
    image: x.image ?? null,
    twoFactorEnabled: Boolean(x.twoFactorEnabled),
  }));
}

/** Resolve the better-auth member.id (needed by updateMemberRole) + current role from an app
 *  userId within an org. Null when the user isn't a member of that org. */
export async function resolveMember(
  orgId: string,
  userId: string,
): Promise<{ memberId: string; role: string } | null> {
  const r = await authPool.query(
    `SELECT id, role FROM "member" WHERE "organizationId" = $1 AND "userId" = $2 LIMIT 1`,
    [orgId, userId],
  );
  return r.rowCount ? { memberId: r.rows[0].id as string, role: r.rows[0].role as string } : null;
}

/** How many owners the org has — the guardrail input for "never demote/remove the last owner". */
export async function countOwners(orgId: string): Promise<number> {
  const r = await authPool.query(
    `SELECT count(*)::int AS n FROM "member" WHERE "organizationId" = $1 AND role = 'owner'`,
    [orgId],
  );
  return r.rows[0].n as number;
}
