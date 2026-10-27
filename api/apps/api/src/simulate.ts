import { withTenant } from "@repo/db";
import { suggestForQuery } from "./copilot.js";
import { ruleScore } from "./qa.js";
import { classifyRisk, clip } from "./model.js";

// Agent simulation / eval harness — run the AI resolver over a sample of PAST tickets (their real
// customer question) without sending anything, and record how it WOULD have answered: the draft, a
// would-be QA score, retrieval grounding, and whether it would have cleared the auto-send gate. This
// lets a team measure the agent's readiness before trusting it. Reuses the ONE draft path
// (copilot.suggestForQuery, source="eval" so the trace is tagged) and the ONE QA rule scorer — a
// simulation is just those two composed over a historical sample, persisted as a run + item rows.

// The auto-send gate the live autoreply uses: ≥2 distinct grounding source kinds AND no business-risk
// guardrail trip. Mirrored here (not imported) so the sim reports the same yes/no the gate would.
const MIN_AGREEMENT = 2;

function wouldAutoSend(question: string, agreement: number): boolean {
  return agreement >= MIN_AGREEMENT && classifyRisk(question).length === 0;
}

export interface SimItem {
  ticket_id: string;
  subject: string;
  question: string;
  draft: string;
  score: number;
  confidence: number | null;
  agreement: number;
  citations: number;
  would_auto_send: boolean;
}

export interface SimRun {
  id: string;
  label: string;
  sample_size: number;
  avg_score: number | null;
  avg_confidence: number | null;
  auto_send_rate: number;
  coverage: number;
  model: string;
  created_at: string;
}

/** Pick a sample of past tickets that have a customer question to answer. Resolved tickets first
 *  (a known-good baseline to compare against), newest of them; random within to vary the sample. */
async function sampleTickets(tenantId: string, n: number): Promise<{ id: string; subject: string; sentiment: string | null; question: string }[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT t.id, t.subject, t.sentiment,
              (SELECT m.body FROM messages m
                WHERE m.ticket_id = t.id AND m.tenant_id = t.tenant_id AND m.author_type = 'customer'
                ORDER BY m.created_at ASC LIMIT 1) AS question
         FROM tickets t
        WHERE t.merged_into IS NULL
          AND EXISTS (SELECT 1 FROM messages m WHERE m.ticket_id = t.id AND m.tenant_id = t.tenant_id AND m.author_type = 'customer')
        ORDER BY (t.status = 'closed') DESC, random()
        LIMIT $1`,
      [n],
    );
    return r.rows
      .filter((x) => typeof x.question === "string" && x.question.trim().length > 0)
      .map((x) => ({ id: x.id as string, subject: (x.subject as string) ?? "", sentiment: x.sentiment as string | null, question: x.question as string }));
  });
}

/**
 * Run a simulation over `sampleSize` past tickets. For each: draft an answer through the resolver,
 * score it with the QA rule scorer (as if that draft were the agent's reply on a resolved ticket),
 * and record the grounding + would-auto-send signals. Persists one run + N item rows and returns
 * the run with its items. sampleSize is clamped to 1..25 to bound model spend.
 */
export async function runSimulation(
  tenantId: string,
  opts: { sampleSize?: number; label?: string } = {},
): Promise<{ run: SimRun; items: SimItem[] }> {
  const n = Math.min(Math.max(opts.sampleSize ?? 10, 1), 25);
  const sample = await sampleTickets(tenantId, n);

  const items: SimItem[] = [];
  let modelName = "rule";
  for (const t of sample) {
    let draft = "", confidence: number | null = null, agreement = 0, citations = 0;
    try {
      const s = await suggestForQuery(tenantId, t.question, { ticketId: t.id, source: "eval" });
      draft = s.draft;
      confidence = s.confidence;
      agreement = s.retrieval.agreement;
      citations = s.citations.length;
      modelName = s.model;
    } catch {
      /* a single draft failure shouldn't sink the run — score it as an empty answer */
    }
    // Score the would-be answer with the QA rule scorer: treat [question, draft] as a resolved
    // thread so the number is comparable to real conversation QA.
    const qa = ruleScore(
      { subject: t.subject, status: "closed", sentiment: t.sentiment, created_at: "", closed_at: "x" },
      [
        { author_type: "customer", body: t.question, auto: false },
        ...(draft ? [{ author_type: "agent", body: draft, auto: true }] : []),
      ],
    );
    items.push({
      ticket_id: t.id,
      subject: t.subject,
      question: clip(t.question, 300),
      draft: clip(draft, 600),
      score: qa.overall,
      confidence,
      agreement,
      citations,
      would_auto_send: wouldAutoSend(t.question, agreement),
    });
  }

  // Aggregate.
  const count = items.length;
  const avgScore = count ? Math.round(items.reduce((s, i) => s + i.score, 0) / count) : null;
  const conf = items.map((i) => i.confidence).filter((c): c is number => c != null);
  const avgConfidence = conf.length ? Math.round((conf.reduce((s, c) => s + c, 0) / conf.length) * 100) / 100 : null;
  const autoSendRate = count ? Math.round((items.filter((i) => i.would_auto_send).length / count) * 100) / 100 : 0;
  const coverage = count ? Math.round((items.filter((i) => i.agreement >= 1).length / count) * 100) / 100 : 0;

  const run = await withTenant(tenantId, async (c) => {
    const rr = await c.query(
      `INSERT INTO simulation_runs (tenant_id, label, sample_size, avg_score, avg_confidence, auto_send_rate, coverage, model)
       VALUES (current_tenant(), $1, $2, $3, $4, $5, $6, $7)
       RETURNING id, label, sample_size, avg_score, avg_confidence, auto_send_rate, coverage, model, created_at`,
      [opts.label ?? "", count, avgScore, avgConfidence, autoSendRate, coverage, modelName],
    );
    const row = rr.rows[0] as SimRun;
    for (const it of items) {
      await c.query(
        `INSERT INTO simulation_items
           (tenant_id, run_id, ticket_id, subject, question, draft, score, confidence, agreement, citations, would_auto_send)
         VALUES (current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (tenant_id, run_id, ticket_id) DO NOTHING`,
        [row.id, it.ticket_id, it.subject, it.question, it.draft, it.score, it.confidence, it.agreement, it.citations, it.would_auto_send],
      );
    }
    return row;
  });

  return { run, items };
}

const RUN_COLS = "id, label, sample_size, avg_score, avg_confidence, auto_send_rate, coverage, model, created_at";

export async function listSimulations(tenantId: string, limit = 50): Promise<SimRun[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT ${RUN_COLS} FROM simulation_runs ORDER BY created_at DESC LIMIT $1`,
      [Math.min(Math.max(limit, 1), 100)],
    );
    return r.rows as SimRun[];
  });
}

export async function getSimulation(tenantId: string, id: string): Promise<{ run: SimRun; items: SimItem[] } | null> {
  return withTenant(tenantId, async (c) => {
    const rr = await c.query(`SELECT ${RUN_COLS} FROM simulation_runs WHERE id = $1`, [id]);
    if (!rr.rowCount) return null;
    const ir = await c.query(
      `SELECT ticket_id, subject, question, draft, score, confidence, agreement, citations, would_auto_send
         FROM simulation_items WHERE run_id = $1 ORDER BY score ASC`,
      [id],
    );
    return { run: rr.rows[0] as SimRun, items: ir.rows as SimItem[] };
  });
}
