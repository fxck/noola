import { withTenant } from "@repo/db";

// CSAT — customer-satisfaction. The customer rates a resolved ticket 1..5 (+ optional
// comment) through the public API / widget; we store one row per submission and aggregate
// for analytics. "Positive" = 4 or 5 (the standard CSAT top-two-box). All RLS-scoped.

export interface CsatResponse {
  id: string;
  ticket_id: string;
  rating: number;
  comment: string | null;
  created_at: string;
}

export interface CsatSummary {
  responses: number;
  average: number | null; // mean rating, 1 decimal
  positive: number; // count of 4-5
  positivePct: number; // top-two-box %, 1 decimal
  distribution: { rating: number; count: number }[]; // 1..5, always all five buckets
}

/** Record a CSAT submission. Returns null if the ticket isn't visible (caller 404s). */
export async function recordCsat(
  tenantId: string,
  ticketId: string,
  rating: number,
  comment?: string | null,
): Promise<CsatResponse | null> {
  return withTenant(tenantId, async (c) => {
    const ok = await c.query(`SELECT 1 FROM tickets WHERE id = $1`, [ticketId]);
    if (!ok.rowCount) return null;
    const r = await c.query(
      `INSERT INTO csat_responses (tenant_id, ticket_id, rating, comment)
       VALUES (current_tenant(), $1, $2, $3)
       RETURNING id, ticket_id, rating, comment, created_at`,
      [ticketId, rating, comment?.trim() || null],
    );
    return r.rows[0] as CsatResponse;
  });
}

/** The most recent CSAT response for a ticket (shown on the detail page), or null. */
export async function getTicketCsat(tenantId: string, ticketId: string): Promise<CsatResponse | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT id, ticket_id, rating, comment, created_at FROM csat_responses
        WHERE ticket_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [ticketId],
    );
    return (r.rows[0] as CsatResponse) ?? null;
  });
}

/** Tenant-wide CSAT rollup for the analytics dashboard. */
export async function csatSummary(tenantId: string): Promise<CsatSummary> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT count(*)::int AS responses,
              round(avg(rating)::numeric, 1) AS average,
              count(*) FILTER (WHERE rating >= 4)::int AS positive
         FROM csat_responses`,
    );
    const distR = await c.query(
      `SELECT rating, count(*)::int AS count FROM csat_responses GROUP BY rating`,
    );
    const row = r.rows[0] as { responses: number; average: string | null; positive: number };
    const responses = Number(row.responses) || 0;
    const positive = Number(row.positive) || 0;
    const byRating = new Map<number, number>(distR.rows.map((x) => [Number(x.rating), Number(x.count)]));
    return {
      responses,
      average: row.average == null ? null : Number(row.average),
      positive,
      positivePct: responses > 0 ? Math.round((positive / responses) * 1000) / 10 : 0,
      distribution: [1, 2, 3, 4, 5].map((rating) => ({ rating, count: byRating.get(rating) ?? 0 })),
    };
  });
}
