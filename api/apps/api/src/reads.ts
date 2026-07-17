import { withTenant } from "@repo/db";

// Per-agent read state. A ticket is "unread" for an agent when it holds a customer message newer than
// that agent's last_read_at (or they've never opened it). Marking read on open upserts the timestamp;
// the inbox fetches the set of unread ids for the current agent and shows a dot. Per-agent by design —
// one agent reading a ticket never clears the unread state for another.

/** Upsert the current agent's read marker for a ticket to now(). */
export async function markTicketRead(tenantId: string, ticketId: string, userId: string): Promise<void> {
  await withTenant(tenantId, (c) =>
    c.query(
      `INSERT INTO ticket_reads (tenant_id, ticket_id, user_id, last_read_at)
         VALUES (current_tenant(), $1, $2, now())
       ON CONFLICT (tenant_id, ticket_id, user_id)
         DO UPDATE SET last_read_at = now()`,
      [ticketId, userId],
    ),
  );
}

/**
 * The set of OPEN ticket ids that are unread for `userId` — a customer message exists that is newer
 * than the agent's last read (or the agent has never opened the ticket). Bounded so a huge backlog
 * can't return an unbounded id list; the inbox only needs the currently-visible page's worth.
 */
export async function unreadTicketIds(tenantId: string, userId: string, limit = 500): Promise<string[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT t.id
         FROM tickets t
         JOIN messages m ON m.ticket_id = t.id AND m.tenant_id = t.tenant_id AND m.author_type = 'customer'
         LEFT JOIN ticket_reads r
                ON r.ticket_id = t.id AND r.tenant_id = t.tenant_id AND r.user_id = $1
        WHERE t.status = 'open'
        GROUP BY t.id
       HAVING max(m.created_at) > COALESCE(max(r.last_read_at), 'epoch'::timestamptz)
        LIMIT $2`,
      [userId, limit],
    );
    return r.rows.map((x) => x.id as string);
  });
}
