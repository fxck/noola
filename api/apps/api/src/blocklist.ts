import { withTenant } from "@repo/db";

// Sender blocklist — the enforcement half of "Mark as spam". An inbound whose sender matches a live
// block is dropped at the inbound seam BEFORE a ticket/lead is created, so a spammer who rotates
// subjects can't keep reopening work. Two scopes:
//   'address' → the exact handle (vlastimila@spam.example)
//   'domain'  → any local-part under the handle's domain (spam.example)
// Handles are stored + compared lowercased. Keyed by channel_type so a blocked email address never
// accidentally gags a same-string handle on another channel.

export type BlockScope = "address" | "domain";

export interface BlockedSender {
  id: string;
  channelType: string;
  scope: BlockScope;
  handle: string;
  reason: string | null;
  createdBy: string | null;
  createdAt: string;
}

/** The domain half of an email-style handle (lowercased), or null when the handle has no '@'. */
export function handleDomain(handle: string): string | null {
  const at = handle.lastIndexOf("@");
  if (at < 0) return null;
  const dom = handle.slice(at + 1).trim().toLowerCase();
  return dom || null;
}

/** True when this sender is blocked on this channel — either an exact-address block, or a domain
 *  block covering the handle's domain. Cheap single-query check on the ingest hot path. */
export async function isSenderBlocked(tenantId: string, channelType: string, handle: string): Promise<boolean> {
  const lc = handle.trim().toLowerCase();
  if (!lc) return false;
  const domain = handleDomain(lc);
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT 1 FROM blocked_senders
        WHERE channel_type = $1
          AND ( (scope = 'address' AND lower(handle) = $2)
             OR (scope = 'domain'  AND $3::text IS NOT NULL AND lower(handle) = $3) )
        LIMIT 1`,
      [channelType, lc, domain],
    );
    return (r.rowCount ?? 0) > 0;
  });
}

const COLS = "id, channel_type, scope, handle, reason, created_by, created_at";

function rowToBlocked(x: Record<string, unknown>): BlockedSender {
  return {
    id: x.id as string,
    channelType: x.channel_type as string,
    scope: (x.scope === "domain" ? "domain" : "address"),
    handle: x.handle as string,
    reason: (x.reason as string | null) ?? null,
    createdBy: (x.created_by as string | null) ?? null,
    createdAt: new Date(x.created_at as string).toISOString(),
  };
}

/** The tenant's blocklist, newest first — for the Settings manager. */
export async function listBlockedSenders(tenantId: string): Promise<BlockedSender[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(`SELECT ${COLS} FROM blocked_senders ORDER BY created_at DESC`);
    return r.rows.map(rowToBlocked);
  });
}

/** Add (or idempotently re-affirm) a block. Handle is normalized to lowercase; a 'domain' scope
 *  handle passed as a full address is reduced to its domain. Returns the stored row. */
export async function blockSender(
  tenantId: string,
  input: { channelType?: string; scope?: BlockScope; handle: string; reason?: string | null; createdBy?: string | null },
): Promise<BlockedSender | null> {
  const channelType = input.channelType ?? "email";
  const scope: BlockScope = input.scope === "domain" ? "domain" : "address";
  let handle = input.handle.trim().toLowerCase();
  if (scope === "domain") handle = handleDomain(handle) ?? handle; // accept a full address, store the domain
  if (!handle) return null;
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO blocked_senders (tenant_id, channel_type, scope, handle, reason, created_by)
         VALUES (current_tenant(), $1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, channel_type, scope, lower(handle))
         DO UPDATE SET reason = COALESCE(EXCLUDED.reason, blocked_senders.reason)
       RETURNING ${COLS}`,
      [channelType, scope, handle, input.reason ?? null, input.createdBy ?? null],
    );
    return r.rowCount ? rowToBlocked(r.rows[0]) : null;
  });
}

/** Remove a block by id (Settings "unblock", and the Unspam undo). */
export async function unblockSender(tenantId: string, id: string): Promise<boolean> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query("DELETE FROM blocked_senders WHERE id = $1", [id]);
    return (r.rowCount ?? 0) > 0;
  });
}

/** Remove a block by its (channel, handle) — the Unspam path, which knows the sender not the row id.
 *  Clears BOTH an exact-address and a domain block for that handle so unspam fully reverses a spam. */
export async function unblockByHandle(tenantId: string, channelType: string, handle: string): Promise<number> {
  const lc = handle.trim().toLowerCase();
  if (!lc) return 0;
  const domain = handleDomain(lc);
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `DELETE FROM blocked_senders
        WHERE channel_type = $1
          AND ( (scope = 'address' AND lower(handle) = $2)
             OR (scope = 'domain'  AND $3::text IS NOT NULL AND lower(handle) = $3) )`,
      [channelType, lc, domain],
    );
    return r.rowCount ?? 0;
  });
}
