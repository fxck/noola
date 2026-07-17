import { withTenant } from "@repo/db";

// Related / linked tickets — a symmetric, non-destructive relation (compare merge, which is
// destructive). Pairs are stored in canonical order (a < b) so a link is one row; lookups for a
// ticket match either side. All RLS-scoped via withTenant.

export interface LinkedTicket {
  id: string;
  subject: string;
  status: string;
  relation: string;
  created_at: string;
}

export type LinkResult =
  | { ok: true; created: boolean }
  | { ok: false; reason: "same_ticket" | "ticket_not_found" };

/** Canonical order: the smaller uuid is `a`. */
function order(x: string, y: string): [string, string] {
  return x < y ? [x, y] : [y, x];
}

/** Link two tickets (symmetric). Idempotent — a repeat is a no-op (`created:false`). */
export async function linkTickets(tenantId: string, id1: string, id2: string, relation = "related"): Promise<LinkResult> {
  if (id1 === id2) return { ok: false, reason: "same_ticket" };
  const [a, b] = order(id1, id2);
  return withTenant(tenantId, async (c) => {
    // Both tickets must be the tenant's (the composite FK would also reject, but check for a clean 404).
    const chk = await c.query("SELECT count(*)::int AS n FROM tickets WHERE id = ANY($1::uuid[])", [[id1, id2]]);
    if (((chk.rows[0]?.n as number) ?? 0) < 2) return { ok: false, reason: "ticket_not_found" } as LinkResult;
    const r = await c.query(
      `INSERT INTO ticket_links (tenant_id, a, b, relation) VALUES (current_tenant(), $1, $2, $3)
       ON CONFLICT (tenant_id, a, b) DO NOTHING RETURNING a`,
      [a, b, relation],
    );
    return { ok: true, created: (r.rowCount ?? 0) > 0 } as LinkResult;
  });
}

/** Remove the link between two tickets (order-independent). */
export async function unlinkTickets(tenantId: string, id1: string, id2: string): Promise<boolean> {
  const [a, b] = order(id1, id2);
  return withTenant(tenantId, async (c) => {
    const r = await c.query("DELETE FROM ticket_links WHERE a = $1 AND b = $2", [a, b]);
    return (r.rowCount ?? 0) > 0;
  });
}

/** List the tickets linked to `ticketId`, hydrated with subject + status. */
export async function listLinks(tenantId: string, ticketId: string): Promise<LinkedTicket[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT t.id, t.subject, t.status, l.relation, l.created_at
         FROM ticket_links l
         JOIN tickets t ON t.tenant_id = l.tenant_id
                       AND t.id = CASE WHEN l.a = $1 THEN l.b ELSE l.a END
        WHERE l.a = $1 OR l.b = $1
        ORDER BY l.created_at DESC`,
      [ticketId],
    );
    return r.rows.map((x) => ({
      id: x.id as string,
      subject: x.subject as string,
      status: x.status as string,
      relation: x.relation as string,
      created_at: new Date(x.created_at as string).toISOString(),
    }));
  });
}
