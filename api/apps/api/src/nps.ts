import { withTenant } from "@repo/db";

// NPS — Net Promoter Score. Score 0..10; promoter 9-10, passive 7-8, detractor 0-6.
// NPS = %promoters − %detractors (range −100..100). Submitted via the public API. RLS-scoped.

export interface NpsResponse {
  id: string;
  ticket_id: string | null;
  score: number;
  comment: string | null;
  created_at: string;
}

export interface NpsSummary {
  responses: number;
  score: number | null; // the NPS itself, −100..100 (null when no responses)
  promoters: number;
  passives: number;
  detractors: number;
  distribution: { score: number; count: number }[]; // 0..10, all eleven buckets
}

export function npsBucket(score: number): "promoter" | "passive" | "detractor" {
  if (score >= 9) return "promoter";
  if (score >= 7) return "passive";
  return "detractor";
}

/** Record an NPS submission. `ticketId` optional (relationship surveys aren't ticket-bound).
 *  Returns null only if a ticketId was given but isn't visible. */
export async function recordNps(
  tenantId: string,
  score: number,
  comment?: string | null,
  ticketId?: string | null,
): Promise<NpsResponse | null> {
  return withTenant(tenantId, async (c) => {
    if (ticketId) {
      const ok = await c.query(`SELECT 1 FROM tickets WHERE id = $1`, [ticketId]);
      if (!ok.rowCount) return null;
    }
    const r = await c.query(
      `INSERT INTO nps_responses (tenant_id, ticket_id, score, comment)
       VALUES (current_tenant(), $1, $2, $3)
       RETURNING id, ticket_id, score, comment, created_at`,
      [ticketId ?? null, score, comment?.trim() || null],
    );
    return r.rows[0] as NpsResponse;
  });
}

export async function npsSummary(tenantId: string): Promise<NpsSummary> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT count(*)::int AS responses,
              count(*) FILTER (WHERE score >= 9)::int AS promoters,
              count(*) FILTER (WHERE score BETWEEN 7 AND 8)::int AS passives,
              count(*) FILTER (WHERE score <= 6)::int AS detractors
         FROM nps_responses`,
    );
    const distR = await c.query(
      `SELECT score, count(*)::int AS count FROM nps_responses GROUP BY score`,
    );
    const row = r.rows[0] as { responses: number; promoters: number; passives: number; detractors: number };
    const responses = Number(row.responses) || 0;
    const promoters = Number(row.promoters) || 0;
    const detractors = Number(row.detractors) || 0;
    const byScore = new Map<number, number>(distR.rows.map((x) => [Number(x.score), Number(x.count)]));
    return {
      responses,
      score: responses > 0 ? Math.round(((promoters - detractors) / responses) * 100) : null,
      promoters,
      passives: Number(row.passives) || 0,
      detractors,
      distribution: Array.from({ length: 11 }, (_, score) => ({ score, count: byScore.get(score) ?? 0 })),
    };
  });
}
