import { withTenant } from "@repo/db";
import type { TicketFilter } from "./tickets.js";

/** The most tickets one mark-all-as-read touches, newest activity first. */
export const MARK_ALL_READ_LIMIT = 1000;

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

/** Upsert the agent's read marker to now() on every ticket that `filter` matches and that is unread for them.
 *  Returns how many it marked, so repeated calls reach unread tickets past the limit. */
export async function markTicketsRead(
  tenantId: string,
  userId: string,
  filter: TicketFilter,
  limit = MARK_ALL_READ_LIMIT,
): Promise<number> {
  const params = [...filter.params, userId];
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO ticket_reads (tenant_id, ticket_id, user_id, last_read_at)
       SELECT current_tenant(), t.id, $${params.length}::uuid, now()
         FROM tickets t
         ${filter.where}
          AND EXISTS (SELECT 1 FROM messages m
                        LEFT JOIN ticket_reads r ON r.tenant_id = t.tenant_id AND r.ticket_id = t.id AND r.user_id = $${params.length}::uuid
                       WHERE m.tenant_id = t.tenant_id AND m.ticket_id = t.id AND m.author_type = 'customer'
                         AND m.created_at > COALESCE(r.last_read_at, '-infinity'))
        ORDER BY t.updated_at DESC
        LIMIT ${Math.max(1, Math.floor(limit))}
       ON CONFLICT (tenant_id, ticket_id, user_id)
         DO UPDATE SET last_read_at = now()`,
      params,
    );
    return r.rowCount ?? 0;
  });
}

/** The agent's unread tickets per filter, by the rule that markTicketsRead uses. A null filter counts 0. */
export async function unreadCounts<K extends string>(
  tenantId: string,
  userId: string,
  filters: Record<K, TicketFilter | null>,
): Promise<Record<K, number>> {
  return withTenant(tenantId, async (c) => {
    const out = {} as Record<K, number>;
    for (const [key, filter] of Object.entries(filters) as Array<[K, TicketFilter | null]>) {
      if (!filter) {
        out[key] = 0;
        continue;
      }
      const params = [...filter.params, userId];
      const r = await c.query(
        `SELECT count(*)::int AS n
           FROM tickets t
           ${filter.where}
            AND EXISTS (SELECT 1 FROM messages m
                          LEFT JOIN ticket_reads r ON r.tenant_id = t.tenant_id AND r.ticket_id = t.id AND r.user_id = $${params.length}::uuid
                         WHERE m.tenant_id = t.tenant_id AND m.ticket_id = t.id AND m.author_type = 'customer'
                           AND m.created_at > COALESCE(r.last_read_at, '-infinity'))`,
        params,
      );
      out[key] = r.rows[0].n as number;
    }
    return out;
  });
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
        GROUP BY t.id, t.spam_at
       HAVING max(m.created_at) > COALESCE(max(r.last_read_at), 'epoch'::timestamptz)
        -- Hidden spam piles up unread, so inbox tickets come first and the newest within each.
        ORDER BY (t.spam_at IS NULL) DESC, max(m.created_at) DESC
        LIMIT $2`,
      [userId, limit],
    );
    return r.rows.map((x) => x.id as string);
  });
}
