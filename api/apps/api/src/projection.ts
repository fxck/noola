import { withTenant } from "@repo/db";

// ── Reverse identity projection (better-auth → app users/tenants) ────────────
// better-auth owns identity (organization/member/user — RLS-exempt, written only by the
// least-privilege auth_user). The app's tenant-scoped tables key off a uuid `app.tenant_id`
// GUC and reference a per-tenant `users` roster (tickets.assignee_id → users). When identity
// grows at RUNTIME (signup, invite accept, role change, removal) those app rows must follow.
// This module is that projection. (The migrate-time seed projects the OTHER direction for the
// demo data; a reverse backfill in migrate.ts self-heals any gap on deploy.)
//
// Design constraints — studio-auth-migration-plan §9, the redesign a 5-lens adversarial review
// forced after it killed the original SECURITY-DEFINER-trigger approach:
//   §9.1  NOT triggers fired by auth_user (that would hand the identity principal
//         RLS-bypassing app-table writes — the exact surface FORCE-RLS closes). We project in
//         Node through appPool/withTenant as app_user, so every write is RLS-bound to the
//         target tenant. auth_user is never the writer and there are no triggers.
//   §9.2  every `users` write is tenant-scoped: withTenant sets the GUC so RLS WITH CHECK
//         forces tenant_id = the org, and we name (tenant_id, id) in the predicate too.
//   §9.3  member.role is allowlist-MAPPED into the app vocabulary, never copied verbatim
//         (an org-admin-controllable string must not flow straight into an authz-shaped column).
//   §9.5  one identity → one tenant (multi-org deferred): the global users_email_key makes a
//         2nd-tenant projection impossible, so membership creation is single-org-guarded
//         upstream (betterauth.ts before-hooks). This module therefore never expects a
//         cross-tenant email; if one arrives it surfaces as a loud 23505, not a silent write.
// Idempotent (ON CONFLICT upserts); nothing here writes back into better-auth → no loop.

const APP_ROLES = new Set(["owner", "admin", "agent", "viewer"]);

/**
 * Map a better-auth `member.role` string to the app `users.role` vocabulary (§9.3 allowlist).
 * Recognised roles pass through; studio's `member`, the legacy `agent` seed value, unknown, or
 * multi-valued (comma-joined) inputs collapse to the safe working role. Never trust the raw
 * value — it is settable by an org admin through better-auth.
 */
export function mapMemberRole(role: string | null | undefined): string {
  for (const tok of String(role ?? "").toLowerCase().split(",")) {
    const r = tok.trim();
    if (APP_ROLES.has(r)) return r; // owner | admin | agent | viewer, verbatim
  }
  return "agent"; // 'member' (studio), legacy, unknown → the default working role
}

/** Upsert the app `tenants` mirror of a better-auth organization (ids kept UUID-equal). Runs
 *  under withTenant(org.id) so the INSERT's WITH CHECK (id = current_tenant()) is satisfied. */
export async function projectOrganization(org: { id: string; name: string }): Promise<void> {
  await withTenant(org.id, (c) =>
    c.query(
      `INSERT INTO tenants (id, name) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [org.id, org.name],
    ),
  );
}

/**
 * Upsert the tenant-scoped `users` projection of a membership (§9.2 tenant-scoped write,
 * §9.3 mapped role). `tenantId` is the org id; `userId`/`email`/`name` come from the
 * better-auth user; `role` is the raw member role (mapped here). Keeps tickets_assignee_fk /
 * the agent picker (`GET /users`) pointing at a real per-tenant row.
 */
export async function projectMember(
  tenantId: string,
  userId: string,
  email: string,
  name: string,
  role: string,
): Promise<void> {
  const mapped = mapMemberRole(role);
  await withTenant(tenantId, (c) =>
    c.query(
      `INSERT INTO users (tenant_id, id, email, name, role) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, id)
       DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name, role = EXCLUDED.role`,
      [tenantId, userId, email, name || email, mapped],
    ),
  );
}

/**
 * Remove a member's app `users` row (§9.2 tenant-scoped: RLS + an explicit (tenant_id, id)
 * predicate). The tickets_assignee_fk is ON DELETE SET NULL, so their assigned tickets are
 * simply unassigned — never a dangling reference.
 */
export async function unprojectMember(tenantId: string, userId: string): Promise<void> {
  await withTenant(tenantId, (c) =>
    c.query(`DELETE FROM users WHERE tenant_id = $1 AND id = $2`, [tenantId, userId]),
  );
}
