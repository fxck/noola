import { withTenant } from "@repo/db";
import { resolveModelDriver } from "./modelconfig.js";

// Conversation QA scoring — grade a handled conversation on three axes (did we RESOLVE it, was the
// TONE right, was the answer COMPLETE) into 0-100 sub-scores + an overall band. A hosted model can
// judge nuance; the deterministic rule scorer is the always-on floor and reads honest structural
// signals (was it closed, is there an agent reply, sentiment trajectory, thread shape). One row per
// ticket in conversation_scores; a re-score upserts. This powers the QA review list where a lead
// spot-checks low-scoring conversations.

export type QaBand = "excellent" | "good" | "fair" | "poor";

export interface QaScore {
  ticket_id: string;
  overall: number;
  resolution: number;
  tone: number;
  completeness: number;
  band: QaBand;
  rationale: string;
  model: string;
  scored_at: string;
}

interface TicketFacts {
  subject: string;
  status: string;
  sentiment: string | null;
  created_at: string;
  closed_at: string | null;
}
interface Msg { author_type: string; body: string; auto: boolean }

function bandOf(overall: number): QaBand {
  if (overall >= 85) return "excellent";
  if (overall >= 70) return "good";
  if (overall >= 50) return "fair";
  return "poor";
}

const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

/**
 * Deterministic scorer — the floor every model beats. Reads structural truth, never prose:
 *  • resolution   — closed with a human/AI reply scores high; open or unanswered scores low.
 *  • tone         — final customer sentiment, penalized for zero agent engagement.
 *  • completeness — agent coverage vs. customer turns + a real (non-trivial) reply length.
 */
export function ruleScore(t: TicketFacts, msgs: Msg[]): Omit<QaScore, "ticket_id" | "scored_at" | "model"> {
  const agent = msgs.filter((m) => m.author_type === "agent");
  const customer = msgs.filter((m) => m.author_type === "customer");
  const answered = agent.length > 0;
  const closed = t.status === "closed";
  const longestAgent = agent.reduce((mx, m) => Math.max(mx, m.body.trim().length), 0);

  // Resolution: closed+answered is the ideal; unanswered or still-open drags it down.
  let resolution = 40;
  if (closed) resolution += 35;
  if (answered) resolution += 20;
  if (closed && answered) resolution += 5;
  if (!answered) resolution -= 25;
  if (t.sentiment === "negative" && closed) resolution -= 15; // closed while the customer's still unhappy

  // Tone: sentiment-led, but no engagement can't earn a good tone score.
  let tone = 65;
  if (t.sentiment === "positive") tone += 25;
  else if (t.sentiment === "negative") tone -= 25;
  if (!answered) tone -= 20;
  else if (agent.length >= 2) tone += 5; // sustained engagement reads as attentive

  // Completeness: did the reply cover the customer's turns and say something substantive?
  let completeness = 45;
  if (answered) completeness += 25;
  if (customer.length > 0 && agent.length >= customer.length) completeness += 15;
  if (longestAgent >= 200) completeness += 15;
  else if (longestAgent >= 60) completeness += 8;
  if (!answered) completeness -= 20;

  const r = clamp(resolution), to = clamp(tone), co = clamp(completeness);
  const overall = clamp(r * 0.45 + to * 0.25 + co * 0.3);
  const rationale = [
    closed ? "resolved" : "still open",
    answered ? `${agent.length} agent repl${agent.length === 1 ? "y" : "ies"}` : "no agent reply",
    t.sentiment ? `${t.sentiment} sentiment` : "neutral",
  ].join(" · ");
  return { overall, resolution: r, tone: to, completeness: co, band: bandOf(overall), rationale };
}

const SYSTEM_PROMPT =
  "You are a support-quality reviewer. Score the conversation below on three axes, each 0-100: " +
  "resolution (was the customer's problem actually solved), tone (empathetic, professional), and " +
  "completeness (did the reply fully address every question). Respond with ONLY a JSON object: " +
  '{"resolution":N,"tone":N,"completeness":N,"rationale":"one short sentence"}. No prose outside the JSON.';

function parseModelScore(raw: string): { resolution: number; tone: number; completeness: number; rationale: string } | null {
  const s = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = s.indexOf("{"), end = s.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    const o = JSON.parse(s.slice(start, end + 1)) as Record<string, unknown>;
    const n = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? clamp(v) : null);
    const res = n(o.resolution), tone = n(o.tone), comp = n(o.completeness);
    if (res === null || tone === null || comp === null) return null;
    return { resolution: res, tone, completeness: comp, rationale: typeof o.rationale === "string" ? o.rationale.slice(0, 300) : "" };
  } catch {
    return null;
  }
}

/**
 * Score one ticket and upsert into conversation_scores. Returns null when the ticket has no
 * messages (nothing to score). Uses the tenant's hosted model when it can, else the rule floor.
 */
export async function scoreTicket(tenantId: string, ticketId: string): Promise<QaScore | null> {
  const data = await withTenant(tenantId, async (c) => {
    const tr = await c.query(
      "SELECT subject, status, sentiment, created_at, closed_at FROM tickets WHERE id = $1",
      [ticketId],
    );
    if (!tr.rowCount) return null;
    const mr = await c.query(
      "SELECT author_type, body, auto FROM messages WHERE ticket_id = $1 ORDER BY created_at ASC LIMIT 100",
      [ticketId],
    );
    return { ticket: tr.rows[0] as TicketFacts, msgs: mr.rows as Msg[] };
  });
  if (!data || data.msgs.length === 0) return null;

  const base = ruleScore(data.ticket, data.msgs);
  let scored = base;
  let model = "rule";

  const driver = await resolveModelDriver(tenantId);
  if (driver.complete) {
    const transcript = data.msgs
      .map((m) => `${m.author_type === "customer" ? "Customer" : "Agent"}: ${m.body}`)
      .join("\n")
      .slice(0, 10000);
    try {
      const parsed = parseModelScore(await driver.complete(SYSTEM_PROMPT, transcript));
      if (parsed) {
        const overall = clamp(parsed.resolution * 0.45 + parsed.tone * 0.25 + parsed.completeness * 0.3);
        scored = { ...parsed, overall, band: bandOf(overall), rationale: parsed.rationale || base.rationale };
        model = driver.name;
      }
    } catch {
      /* keep the rule score */
    }
  }

  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO conversation_scores
         (tenant_id, ticket_id, overall, resolution, tone, completeness, band, rationale, model, scored_at)
       VALUES (current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (tenant_id, ticket_id) DO UPDATE SET
         overall = EXCLUDED.overall, resolution = EXCLUDED.resolution, tone = EXCLUDED.tone,
         completeness = EXCLUDED.completeness, band = EXCLUDED.band, rationale = EXCLUDED.rationale,
         model = EXCLUDED.model, scored_at = now()
       RETURNING ticket_id, overall, resolution, tone, completeness, band, rationale, model, scored_at`,
      [ticketId, scored.overall, scored.resolution, scored.tone, scored.completeness, scored.band, scored.rationale, model],
    );
    return r.rows[0] as QaScore;
  });
}

/** Best-effort scoring hook (used when a ticket closes) — never throws into the caller. */
export async function scoreTicketBestEffort(tenantId: string, ticketId: string): Promise<void> {
  try {
    await scoreTicket(tenantId, ticketId);
  } catch {
    /* QA scoring is advisory — a failure must never affect the close */
  }
}

export interface QaListRow extends QaScore {
  subject: string;
  status: string;
  assignee_name: string | null;
}

/** The QA review list: scores joined to their tickets, worst-first by default so leads triage the
 *  weak conversations. band filters to one grade. */
export async function listScores(
  tenantId: string,
  opts: { band?: string; limit?: number } = {},
): Promise<QaListRow[]> {
  return withTenant(tenantId, async (c) => {
    const params: unknown[] = [];
    let where = "";
    if (opts.band) {
      params.push(opts.band);
      where = `WHERE cs.band = $${params.length}`;
    }
    params.push(Math.min(Math.max(opts.limit ?? 100, 1), 200));
    const r = await c.query(
      `SELECT cs.ticket_id, cs.overall, cs.resolution, cs.tone, cs.completeness, cs.band,
              cs.rationale, cs.model, cs.scored_at,
              t.subject, t.status, u.name AS assignee_name
         FROM conversation_scores cs
         JOIN tickets t ON t.id = cs.ticket_id AND t.tenant_id = cs.tenant_id
         LEFT JOIN users u ON u.id = t.assignee_id AND u.tenant_id = t.tenant_id
        ${where}
        ORDER BY cs.overall ASC, cs.scored_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return r.rows as QaListRow[];
  });
}

export interface QaSummary {
  scored: number;
  avgOverall: number | null;
  byBand: Record<QaBand, number>;
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));

/** Header stats for the QA page: how many scored, the mean, and the band distribution. */
export async function qaSummary(tenantId: string): Promise<QaSummary> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT count(*)::int AS scored, avg(overall) AS avg_overall,
              count(*) FILTER (WHERE band = 'excellent')::int AS excellent,
              count(*) FILTER (WHERE band = 'good')::int AS good,
              count(*) FILTER (WHERE band = 'fair')::int AS fair,
              count(*) FILTER (WHERE band = 'poor')::int AS poor
         FROM conversation_scores`,
    );
    const row = r.rows[0] as Record<string, unknown>;
    return {
      scored: num(row.scored),
      avgOverall: row.avg_overall == null ? null : Math.round(Number(row.avg_overall)),
      byBand: { excellent: num(row.excellent), good: num(row.good), fair: num(row.fair), poor: num(row.poor) },
    };
  });
}

export interface QaAgentRow {
  agentId: string;
  agentName: string;
  scored: number;
  avgOverall: number;
  avgResolution: number;
  avgTone: number;
  avgCompleteness: number;
  byBand: Record<QaBand, number>;
}

/** Coaching leaderboard: per-assignee QA rollup (avg overall + sub-scores + band mix), best-first.
 *  Only assignee-scoped scores count; unassigned conversations are excluded. */
export async function qaByAgent(tenantId: string): Promise<QaAgentRow[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT t.assignee_id AS agent_id, u.name AS agent_name,
              count(*)::int AS scored,
              round(avg(cs.overall))::int AS avg_overall,
              round(avg(cs.resolution))::int AS avg_resolution,
              round(avg(cs.tone))::int AS avg_tone,
              round(avg(cs.completeness))::int AS avg_completeness,
              count(*) FILTER (WHERE cs.band = 'excellent')::int AS excellent,
              count(*) FILTER (WHERE cs.band = 'good')::int AS good,
              count(*) FILTER (WHERE cs.band = 'fair')::int AS fair,
              count(*) FILTER (WHERE cs.band = 'poor')::int AS poor
         FROM conversation_scores cs
         JOIN tickets t ON t.id = cs.ticket_id AND t.tenant_id = cs.tenant_id
         JOIN users u ON u.id = t.assignee_id AND u.tenant_id = t.tenant_id
        WHERE t.assignee_id IS NOT NULL
        GROUP BY t.assignee_id, u.name
        ORDER BY avg_overall DESC, scored DESC
        LIMIT 50`,
    );
    return r.rows.map((x): QaAgentRow => ({
      agentId: x.agent_id as string,
      agentName: (x.agent_name as string) ?? "Unknown",
      scored: num(x.scored),
      avgOverall: num(x.avg_overall),
      avgResolution: num(x.avg_resolution),
      avgTone: num(x.avg_tone),
      avgCompleteness: num(x.avg_completeness),
      byBand: { excellent: num(x.excellent), good: num(x.good), fair: num(x.fair), poor: num(x.poor) },
    }));
  });
}

export interface QaCsatCorrelation {
  pairs: number; // tickets with BOTH a QA score and a CSAT rating
  avgQaWhenHappy: number | null; // avg QA overall where CSAT rating ≥ 4
  avgQaWhenUnhappy: number | null; // avg QA overall where CSAT rating ≤ 2
  avgCsatWhenHighQa: number | null; // avg CSAT where QA overall ≥ 70
  avgCsatWhenLowQa: number | null; // avg CSAT where QA overall < 70
}

/** Does the QA score track what customers actually reported? Join conversation_scores to CSAT and
 *  contrast QA by satisfaction (and vice-versa) — a directional read a lead can trust or question. */
export async function qaCsatCorrelation(tenantId: string): Promise<QaCsatCorrelation> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `WITH paired AS (
         SELECT cs.overall AS qa, cr.rating AS csat
           FROM conversation_scores cs
           JOIN csat_responses cr ON cr.ticket_id = cs.ticket_id AND cr.tenant_id = cs.tenant_id
       )
       SELECT count(*)::int AS pairs,
              avg(qa)   FILTER (WHERE csat >= 4) AS qa_happy,
              avg(qa)   FILTER (WHERE csat <= 2) AS qa_unhappy,
              avg(csat) FILTER (WHERE qa >= 70)  AS csat_highqa,
              avg(csat) FILTER (WHERE qa < 70)   AS csat_lowqa
         FROM paired`,
    );
    const row = r.rows[0] as Record<string, unknown>;
    const round1 = (v: unknown): number | null => (v == null ? null : Math.round(Number(v) * 10) / 10);
    return {
      pairs: num(row.pairs),
      avgQaWhenHappy: row.qa_happy == null ? null : Math.round(Number(row.qa_happy)),
      avgQaWhenUnhappy: row.qa_unhappy == null ? null : Math.round(Number(row.qa_unhappy)),
      avgCsatWhenHighQa: round1(row.csat_highqa),
      avgCsatWhenLowQa: round1(row.csat_lowqa),
    };
  });
}

/**
 * Backfill scores for the most recent handled tickets that don't have one yet (bounded). Returns
 * how many were scored. Powers the "Score conversations" action on an empty QA page.
 */
export async function backfillScores(tenantId: string, limit = 50): Promise<number> {
  const ids = await withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT t.id
         FROM tickets t
         LEFT JOIN conversation_scores cs ON cs.ticket_id = t.id AND cs.tenant_id = t.tenant_id
        WHERE cs.ticket_id IS NULL
          AND EXISTS (SELECT 1 FROM messages m WHERE m.ticket_id = t.id AND m.tenant_id = t.tenant_id)
        ORDER BY t.updated_at DESC
        LIMIT $1`,
      [Math.min(Math.max(limit, 1), 200)],
    );
    return r.rows.map((x) => x.id as string);
  });
  let scored = 0;
  for (const id of ids) {
    const s = await scoreTicket(tenantId, id);
    if (s) scored++;
  }
  return scored;
}
