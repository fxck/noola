import { withTenant } from "@repo/db";

// ── Content-gap detection (knowledge-loop) ────────────────────────────────────
// A "knowledge gap" is a customer question the KB couldn't answer: every RAG answer runs through
// copilot.suggestForQuery, which yields a retrieval summary (topScore, agreement) + confidence.
// When retrieval is WEAK we record the question here, CLUSTERED by a normalized key so the same
// unanswered question increments `occurrences` instead of spamming rows. The Sources worklist
// surfaces the top gaps → author a KB article → resolve the gap. Recording is best-effort (never
// blocks or fails the answer). All RLS-scoped via withTenant.

// Weak-retrieval thresholds. Scores are unnormalized RRF (~1/61 ≈ 0.016 per contributing list), so
// agreement (how many distinct source kinds corroborated) is the primary signal and top score the
// secondary. A gap = nothing retrieved at all, OR only a single feeble hit.
const GAP_MIN_TOPSCORE = 0.02;
// Ignore trivially short queries ("hi", "thanks") and pathological lengths — they're not real
// answerable questions and would pollute the worklist.
const MIN_QUESTION_LEN = 8;
const MAX_QUESTION_LEN = 500;

export interface KnowledgeGap {
  id: string;
  question: string;
  confidence: number | null;
  topScore: number | null;
  agreement: number;
  source: string;
  ticketId: string | null;
  occurrences: number;
  status: "open" | "resolved" | "dismissed";
  resolvedArticleId: string | null;
  firstSeen: string;
  lastSeen: string;
}

/** True when a retrieval result represents a content gap (the KB had no good answer). */
export function isContentGap(agreement: number, topScore: number): boolean {
  return agreement <= 0 || topScore < GAP_MIN_TOPSCORE;
}

/** Group key for clustering repeats: lowercase, collapse whitespace, strip surrounding punctuation.
 *  Deliberately simple (no stemming) — good enough to fold "How do I reset?" ≈ "how do i reset". */
export function normalizeQuestion(q: string): string {
  return q
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "")
    .trim()
    .slice(0, MAX_QUESTION_LEN);
}

export interface GapSignal {
  query: string;
  confidence: number | null;
  topScore: number;
  agreement: number;
  source?: string;
  ticketId?: string | null;
}

/** Record a content gap (best-effort, fire-and-forget). Upserts on (tenant, normalized): a repeat
 *  bumps `occurrences` + `last_seen` and refreshes the signals, WITHOUT reopening a gap an agent
 *  already dismissed/resolved (their triage sticks). Skips eval traffic + non-question noise. */
export async function recordKnowledgeGap(tenantId: string, s: GapSignal): Promise<void> {
  if ((s.source ?? "live") === "eval") return; // eval harness must not pollute the worklist
  const question = (s.query ?? "").trim();
  if (question.length < MIN_QUESTION_LEN) return;
  const normalized = normalizeQuestion(question);
  if (normalized.length < MIN_QUESTION_LEN) return;
  try {
    await withTenant(tenantId, async (c) => {
      await c.query(
        `INSERT INTO knowledge_gaps
           (tenant_id, question, normalized, confidence, top_score, agreement, source, ticket_id)
         VALUES (current_tenant(), $1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, normalized) DO UPDATE SET
           occurrences = knowledge_gaps.occurrences + 1,
           last_seen   = now(),
           question    = EXCLUDED.question,
           confidence  = EXCLUDED.confidence,
           top_score   = EXCLUDED.top_score,
           agreement   = EXCLUDED.agreement,
           ticket_id   = COALESCE(EXCLUDED.ticket_id, knowledge_gaps.ticket_id)`,
        [question.slice(0, MAX_QUESTION_LEN), normalized, s.confidence, s.topScore, s.agreement, s.source ?? "live", s.ticketId ?? null],
      );
    });
  } catch {
    /* best-effort: a gap-recording failure must never break the answer path */
  }
}

function mapGap(r: Record<string, unknown>): KnowledgeGap {
  return {
    id: r.id as string,
    question: r.question as string,
    confidence: r.confidence != null ? Number(r.confidence) : null,
    topScore: r.top_score != null ? Number(r.top_score) : null,
    agreement: Number(r.agreement ?? 0),
    source: r.source as string,
    ticketId: (r.ticket_id as string) ?? null,
    occurrences: Number(r.occurrences ?? 1),
    status: r.status as KnowledgeGap["status"],
    resolvedArticleId: (r.resolved_article_id as string) ?? null,
    firstSeen: new Date(r.first_seen as string).toISOString(),
    lastSeen: new Date(r.last_seen as string).toISOString(),
  };
}

/** The gap worklist: most-frequent first, newest as tiebreak. `status` defaults to open. */
export async function listKnowledgeGaps(
  tenantId: string,
  opts: { status?: string; limit?: number } = {},
): Promise<{ gaps: KnowledgeGap[]; openCount: number }> {
  const status = opts.status && ["open", "resolved", "dismissed", "all"].includes(opts.status) ? opts.status : "open";
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  return withTenant(tenantId, async (c) => {
    const where = status === "all" ? "" : "WHERE status = $2";
    const params: unknown[] = status === "all" ? [limit] : [limit, status];
    const r = await c.query(
      `SELECT id, question, confidence, top_score, agreement, source, ticket_id, occurrences,
              status, resolved_article_id, first_seen, last_seen
         FROM knowledge_gaps ${where}
        ORDER BY occurrences DESC, last_seen DESC
        LIMIT $1`,
      params,
    );
    const openR = await c.query("SELECT count(*)::int AS n FROM knowledge_gaps WHERE status = 'open'");
    return { gaps: r.rows.map(mapGap), openCount: (openR.rows[0]?.n as number) ?? 0 };
  });
}

/** Triage a gap: mark resolved (optionally linking the article that closed it), dismissed, or open. */
export async function updateKnowledgeGap(
  tenantId: string,
  id: string,
  patch: { status?: "open" | "resolved" | "dismissed"; resolvedArticleId?: string | null },
): Promise<KnowledgeGap | null> {
  return withTenant(tenantId, async (c) => {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.status) {
      params.push(patch.status);
      sets.push(`status = $${params.length}`);
    }
    if (patch.resolvedArticleId !== undefined) {
      params.push(patch.resolvedArticleId);
      sets.push(`resolved_article_id = $${params.length}`);
    }
    if (sets.length === 0) {
      const r = await c.query("SELECT * FROM knowledge_gaps WHERE id = $1", [id]);
      return r.rowCount ? mapGap(r.rows[0] as Record<string, unknown>) : null;
    }
    params.push(id);
    const r = await c.query(
      `UPDATE knowledge_gaps SET ${sets.join(", ")} WHERE id = $${params.length}
       RETURNING id, question, confidence, top_score, agreement, source, ticket_id, occurrences,
                 status, resolved_article_id, first_seen, last_seen`,
      params,
    );
    return r.rowCount ? mapGap(r.rows[0] as Record<string, unknown>) : null;
  });
}
