import { randomUUID } from "node:crypto";
import { authPool } from "@repo/db";
import { projectMember, mapMemberRole } from "./projection.js";

// Invite primitives over the RLS-exempt identity surface (authPool / auth_user):
//   • Email invitations — better-auth's own `invitation` table. Creation/cancel/accept go
//     through auth.api (betterauth.ts, which enforces org-admin permission); the READS here are
//     the pending-list + the public landing lookup.
//   • Shareable links — studio's `org_invite_link` (a separate primitive; 0021). Create/list/
//     disable/validate/redeem live here. Redeem writes a `member` row DIRECTLY (no better-auth
//     addMember, which is admin-only — the joiner isn't an admin), so it must ALSO call the
//     reverse projection explicitly (no org hook fires for a raw INSERT).
// No `auth` import → betterauth.ts depends on this without a cycle.

// ---- email invitations (read side) ---------------------------------------

export interface PendingInvite {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: string;
  createdAt: string;
}

/** Pending email invitations for an org (newest first). */
export async function listPendingInvites(orgId: string): Promise<PendingInvite[]> {
  const r = await authPool.query(
    `SELECT id, email, role, status, "expiresAt", "createdAt"
       FROM "invitation" WHERE "organizationId" = $1 AND status = 'pending'
       ORDER BY "createdAt" DESC`,
    [orgId],
  );
  return r.rows.map((x) => ({
    id: x.id, email: x.email, role: x.role, status: x.status, expiresAt: x.expiresAt, createdAt: x.createdAt,
  }));
}

/** Public landing lookup for an email invitation (invitee has no session yet). Returns the org
 *  id/name + inviter + role + status, or null. RLS-exempt read — carries no secret. */
export async function getInvitePublic(id: string): Promise<
  { id: string; email: string; role: string; status: string; expiresAt: string; organizationId: string; orgName: string; inviterName: string | null } | null
> {
  const r = await authPool.query(
    `SELECT i.id, i.email, i.role, i.status, i."expiresAt", i."organizationId" AS organization_id,
            o.name AS org_name, u.name AS inviter_name
       FROM "invitation" i
       JOIN "organization" o ON o.id = i."organizationId"
       LEFT JOIN "user" u ON u.id = i."inviterId"
      WHERE i.id = $1 LIMIT 1`,
    [id],
  );
  if (!r.rowCount) return null;
  const x = r.rows[0];
  return { id: x.id, email: x.email, role: x.role, status: x.status, expiresAt: x.expiresAt, organizationId: x.organization_id, orgName: x.org_name, inviterName: x.inviter_name };
}

// ---- shareable invite links (org_invite_link) ----------------------------

export interface InviteLinkRow {
  token: string;
  organizationId: string;
  role: string;
  expiresAt: string | null;
  maxUses: number | null;
  uses: number;
  allowedDomain: string | null;
  enabled: boolean;
  createdAt: string;
}

function rowToLink(x: Record<string, unknown>): InviteLinkRow {
  return {
    token: x.token as string,
    organizationId: x.organization_id as string,
    role: x.role as string,
    expiresAt: (x.expires_at as string) ?? null,
    maxUses: (x.max_uses as number) ?? null,
    uses: x.uses as number,
    allowedDomain: (x.allowed_domain as string) ?? null,
    enabled: x.enabled as boolean,
    createdAt: x.created_at as string,
  };
}

/** Mint a shareable link (owner/admin only, gated at the route). Token is long + unguessable. */
export async function createInviteLink(
  orgId: string,
  createdBy: string,
  opts: { role: string; maxUses?: number; expiresInDays?: number; allowedDomain?: string },
): Promise<InviteLinkRow> {
  const token = (randomUUID() + randomUUID()).replace(/-/g, "");
  const expiresAt = opts.expiresInDays ? new Date(Date.now() + opts.expiresInDays * 86_400_000).toISOString() : null;
  const r = await authPool.query(
    `INSERT INTO org_invite_link (token, organization_id, role, created_by, expires_at, max_uses, allowed_domain, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)
     RETURNING token, organization_id, role, expires_at, max_uses, uses, allowed_domain, enabled, created_at`,
    [token, orgId, mapMemberRole(opts.role), createdBy, expiresAt, opts.maxUses ?? null, opts.allowedDomain ?? null],
  );
  return rowToLink(r.rows[0]);
}

/** Enabled links for an org (newest first). */
export async function listInviteLinks(orgId: string): Promise<InviteLinkRow[]> {
  const r = await authPool.query(
    `SELECT token, organization_id, role, expires_at, max_uses, uses, allowed_domain, enabled, created_at
       FROM org_invite_link WHERE organization_id = $1 AND enabled ORDER BY created_at DESC`,
    [orgId],
  );
  return r.rows.map(rowToLink);
}

/** Disable a link (org-scoped so an admin can't touch another tenant's link). */
export async function disableInviteLink(orgId: string, token: string): Promise<boolean> {
  const r = await authPool.query(
    `UPDATE org_invite_link SET enabled = false WHERE token = $1 AND organization_id = $2 AND enabled`,
    [token, orgId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Public landing lookup for a link (joiner has no session). Org name + validity, or null. */
export async function getLinkPublic(
  token: string,
): Promise<{ token: string; orgName: string; role: string; valid: boolean; reason?: string } | null> {
  const r = await authPool.query(
    `SELECT l.role, l.expires_at, l.max_uses, l.uses, l.enabled, o.name AS org_name
       FROM org_invite_link l JOIN "organization" o ON o.id = l.organization_id
      WHERE l.token = $1 LIMIT 1`,
    [token],
  );
  if (!r.rowCount) return null;
  const l = r.rows[0];
  let reason: string | undefined;
  if (!l.enabled) reason = "disabled";
  else if (l.expires_at && new Date(l.expires_at) < new Date()) reason = "expired";
  else if (l.max_uses != null && l.uses >= l.max_uses) reason = "exhausted";
  return { token, orgName: l.org_name, role: l.role, valid: !reason, reason };
}

/** Validate a link for a specific joiner email (enabled, unexpired, uses left, domain match). */
export async function validateLink(
  token: string,
  email: string,
): Promise<{ ok: true; orgId: string; role: string } | { ok: false; reason: string }> {
  const r = await authPool.query(
    `SELECT organization_id, role, expires_at, max_uses, uses, allowed_domain, enabled
       FROM org_invite_link WHERE token = $1 LIMIT 1`,
    [token],
  );
  if (!r.rowCount) return { ok: false, reason: "not-found" };
  const l = r.rows[0];
  if (!l.enabled) return { ok: false, reason: "disabled" };
  if (l.expires_at && new Date(l.expires_at) < new Date()) return { ok: false, reason: "expired" };
  if (l.max_uses != null && l.uses >= l.max_uses) return { ok: false, reason: "exhausted" };
  if (l.allowed_domain) {
    const dom = email.split("@")[1]?.toLowerCase();
    if (dom !== String(l.allowed_domain).toLowerCase()) return { ok: false, reason: "domain" };
  }
  return { ok: true, orgId: l.organization_id as string, role: l.role as string };
}

/**
 * Redeem a link: add the joiner to the org as a member and project them into the app roster.
 * Writes `member` directly (better-auth addMember is admin-only) then calls projectMember
 * explicitly (no org hook fires for a raw INSERT). Enforces single-org (§9.5a) itself, since
 * no before-hook covers this path. Idempotent for a repeat of the SAME org.
 */
export async function redeemLinkMember(
  token: string,
  orgId: string,
  userId: string,
  email: string,
  name: string,
  role: string,
): Promise<{ ok: boolean; reason?: string }> {
  const other = await authPool.query(`SELECT "organizationId" FROM "member" WHERE "userId" = $1 LIMIT 1`, [userId]);
  if (other.rowCount) {
    return other.rows[0].organizationId === orgId ? { ok: true } : { ok: false, reason: "multi-org" };
  }
  const mapped = mapMemberRole(role);
  await authPool.query(
    `INSERT INTO "member"(id, "organizationId", "userId", role, "createdAt")
       VALUES ($1, $2, $3, $4, now()) ON CONFLICT ("organizationId", "userId") DO NOTHING`,
    [randomUUID(), orgId, userId, mapped],
  );
  await projectMember(orgId, userId, email, name, mapped);
  await authPool.query(`UPDATE org_invite_link SET uses = uses + 1 WHERE token = $1`, [token]);
  return { ok: true };
}
