import { withTenant, relayPool } from "@repo/db";
import { resolveModelDriver } from "./modelconfig.js";
import { findSources } from "./copilot.js";
import { getDocsSearchSettings } from "./docs-search.js";
import { getTranslationSettings } from "./translate.js";
import { localeName } from "./locale.js";
import { recordGapReviewTrace } from "./trace.js";
import {
  matchInput,
  matchPrompt,
  parseMatch,
  parseQuestions,
  parseReviews,
  questionsPrompt,
  reviewInput,
  reviewPrompt,
  transcriptOf,
  type ConversationKind,
  type GapKind,
  type GapReview,
  type ReviewSource,
  type ReviewTurn,
} from "./gap-review.js";

// Knowledge gaps: a model reviews each closed conversation and files the questions that the docs or the help articles miss.
// Each question joins the gap that asks the same thing, or starts a new one.

/** The review kinds that make a gap. Answered and not reusable questions only count in the summary. */
export const GAP_KINDS = ["docs_missing", "docs_unclear", "support_knowledge"] as const;
const isGapKind = (k: GapKind): k is (typeof GAP_KINDS)[number] => (GAP_KINDS as readonly string[]).includes(k);

// A conversation waits this long after it closes, so a quick reopen does not cost a review.
const REVIEW_DELAY = "10 minutes";
// The backfill after the review is switched on goes back this far.
const REVIEW_WINDOW = "180 days";
// Reviews per sweep, and per workspace in one sweep, so a backfill never holds up the other workspaces. The sweep runs every minute.
const REVIEWS_PER_SWEEP = 5;
const REVIEWS_PER_WORKSPACE = 2;
const MAX_ATTEMPTS = 3;
// Every failure counts here, a provider outage too, so no conversation is retried without end.
const MAX_FAILURES = 10;
const RETRY_AFTER = "6 hours";
// A review that started this long ago and never finished was cut off, so it runs again.
const STALE_REVIEW = "1 hour";
const MODEL_TIMEOUT_MS = 90_000;
// Each question sees this many documentation passages and help articles.
const DOC_SOURCES = 5;
const ARTICLE_SOURCES = 3;
// The gaps that a new question is matched against, the open ones first, then the newest.
const MATCH_GAPS = 300;
// The step-two reply holds up to five reviews, more than a support reply's default limit.
const REVIEW_MAX_TOKENS = 4000;

export interface GapSettings {
  enabled: boolean;
}

export async function getGapSettings(tenantId: string): Promise<GapSettings> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query("SELECT enabled FROM gap_settings WHERE tenant_id = current_tenant()");
    return { enabled: r.rows[0]?.enabled === true };
  });
}

/** The review runs on the workspace's own model, so it cannot be switched on without one. */
export class NeedsHostedModel extends Error {
  constructor() {
    super("The review runs on the workspace's own model. Connect a model first.");
  }
}

export async function putGapSettings(tenantId: string, input: GapSettings): Promise<GapSettings> {
  if (input.enabled && !(await resolveModelDriver(tenantId, { job: "general" })).complete) throw new NeedsHostedModel();
  return withTenant(tenantId, async (c) => {
    await c.query(
      `INSERT INTO gap_settings (tenant_id, enabled) VALUES (current_tenant(), $1)
       ON CONFLICT (tenant_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
      [input.enabled],
    );
    return { enabled: input.enabled };
  });
}

export interface GapQuestion {
  id: string;
  ticketId: string;
  subject: string | null;
  question: string;
  kind: GapKind;
  answer: string | null;
  pageUrl: string | null;
  articleId: string | null;
  suggestion: string | null;
  title: string | null;
  collection: string | null;
  createdAt: string;
}

export interface KnowledgeGap {
  id: string;
  question: string;
  kind: (typeof GAP_KINDS)[number];
  pageUrl: string | null;
  collection: string | null;
  occurrences: number;
  status: "open" | "resolved" | "dismissed";
  resolvedArticleId: string | null;
  firstSeen: string;
  lastSeen: string;
  /** The conversations that raised the gap, the newest first. */
  questions: GapQuestion[];
}

export interface GapSummary {
  reviewed: number;
  conversations: Record<ConversationKind, number>;
  questions: Record<GapKind, number>;
}

// The count comes from the questions, so a deleted conversation never leaves a stale number.
const OCCURRENCES_SQL = "(SELECT count(DISTINCT q.ticket_id) FROM knowledge_gap_questions q WHERE q.gap_id = g.id)";
const GAP_COLS = `g.id, g.question, g.kind, g.page_url, g.collection, ${OCCURRENCES_SQL}::int AS occurrences, g.status, g.resolved_article_id, g.first_seen, g.last_seen`;
// An open gap whose conversations were all deleted is not listed.
const LISTED_SQL = `(g.status <> 'open' OR ${OCCURRENCES_SQL} > 0)`;

function mapGap(r: Record<string, unknown>): KnowledgeGap {
  const questions = ((r.questions as Array<Record<string, unknown>> | null) ?? []).map((q) => ({
    id: q.id as string,
    ticketId: q.ticketId as string,
    subject: (q.subject as string | null) ?? null,
    question: q.question as string,
    kind: q.kind as GapKind,
    answer: (q.answer as string | null) ?? null,
    pageUrl: (q.pageUrl as string | null) ?? null,
    articleId: (q.articleId as string | null) ?? null,
    suggestion: (q.suggestion as string | null) ?? null,
    title: (q.title as string | null) ?? null,
    collection: (q.collection as string | null) ?? null,
    createdAt: new Date(q.createdAt as string).toISOString(),
  }));
  return {
    id: r.id as string,
    question: r.question as string,
    kind: r.kind as KnowledgeGap["kind"],
    pageUrl: (r.page_url as string | null) ?? null,
    collection: (r.collection as string | null) ?? null,
    occurrences: Number(r.occurrences ?? 1),
    status: r.status as KnowledgeGap["status"],
    resolvedArticleId: (r.resolved_article_id as string | null) ?? null,
    firstSeen: new Date(r.first_seen as string).toISOString(),
    lastSeen: new Date(r.last_seen as string).toISOString(),
    questions,
  };
}

const QUESTIONS_SQL = `(SELECT json_agg(json_build_object(
    'id', q.id, 'ticketId', q.ticket_id, 'subject', t.subject, 'question', q.question, 'kind', q.kind, 'answer', q.answer,
    'pageUrl', q.page_url, 'articleId', q.article_id, 'suggestion', q.suggestion, 'title', q.title,
    'collection', q.collection, 'createdAt', q.created_at) ORDER BY q.created_at DESC)
   FROM knowledge_gap_questions q LEFT JOIN tickets t ON t.tenant_id = q.tenant_id AND t.id = q.ticket_id
  WHERE q.gap_id = g.id) AS questions`;

/** The gap worklist, the most asked first, with the review counts of every reviewed conversation. */
export async function listKnowledgeGaps(
  tenantId: string,
  opts: { status?: string; limit?: number } = {},
): Promise<{ gaps: KnowledgeGap[]; openCount: number; summary: GapSummary }> {
  const status = opts.status && ["open", "resolved", "dismissed", "all"].includes(opts.status) ? opts.status : "open";
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  return withTenant(tenantId, async (c) => {
    const where = status === "all" ? `WHERE ${LISTED_SQL}` : `WHERE g.status = $2 AND ${LISTED_SQL}`;
    const params: unknown[] = status === "all" ? [limit] : [limit, status];
    const r = await c.query(
      `SELECT ${GAP_COLS}, ${QUESTIONS_SQL} FROM knowledge_gaps g ${where} ORDER BY occurrences DESC, g.last_seen DESC LIMIT $1`,
      params,
    );
    const open = await c.query(`SELECT count(*)::int AS n FROM knowledge_gaps g WHERE g.status = 'open' AND ${LISTED_SQL}`);
    const conv = await c.query("SELECT conversation, count(*)::int AS n FROM gap_reviews WHERE conversation IS NOT NULL GROUP BY 1");
    const qs = await c.query(
      `SELECT e->>'kind' AS kind, count(*)::int AS n FROM gap_reviews, jsonb_array_elements(questions) e
        WHERE conversation IS NOT NULL GROUP BY 1`,
    );
    const conversations = { questions: 0, account_issue: 0, feedback: 0, no_question: 0 } as Record<ConversationKind, number>;
    for (const row of conv.rows) conversations[row.conversation as ConversationKind] = row.n as number;
    const questions = { answered: 0, docs_missing: 0, docs_unclear: 0, support_knowledge: 0, not_reusable: 0 } as Record<GapKind, number>;
    for (const row of qs.rows) if (row.kind in questions) questions[row.kind as GapKind] = row.n as number;
    const reviewed = Object.values(conversations).reduce((a, b) => a + b, 0);
    return { gaps: r.rows.map(mapGap), openCount: (open.rows[0]?.n as number) ?? 0, summary: { reviewed, conversations, questions } };
  });
}

/** Triage a gap: mark it resolved (optionally with the article that closed it), dismissed, or open again. */
export async function updateKnowledgeGap(
  tenantId: string,
  id: string,
  patch: { status?: "open" | "resolved" | "dismissed"; resolvedArticleId?: string | null },
): Promise<KnowledgeGap | null> {
  return withTenant(tenantId, async (c) => {
    const sets: string[] = [];
    const params: unknown[] = [id];
    if (patch.status) {
      params.push(patch.status);
      sets.push(`status = $${params.length}`);
    }
    if (patch.resolvedArticleId !== undefined) {
      params.push(patch.resolvedArticleId);
      sets.push(`resolved_article_id = $${params.length}`);
    } else if (patch.status && patch.status !== "resolved") {
      // A gap that is no longer resolved keeps no article that resolved it.
      sets.push("resolved_article_id = NULL");
    }
    if (sets.length) await c.query(`UPDATE knowledge_gaps SET ${sets.join(", ")} WHERE id = $1`, params);
    const r = await c.query(`SELECT ${GAP_COLS}, ${QUESTIONS_SQL} FROM knowledge_gaps g WHERE g.id = $1`, [id]);
    return r.rowCount ? mapGap(r.rows[0] as Record<string, unknown>) : null;
  });
}

interface Conversation {
  channel: string;
  subject: string;
  turns: ReviewTurn[];
}

async function loadConversation(tenantId: string, ticketId: string): Promise<Conversation | null> {
  return withTenant(tenantId, async (c) => {
    const t = await c.query("SELECT channel_type, subject FROM tickets WHERE id = $1", [ticketId]);
    if (!t.rowCount) return null;
    const m = await c.query(
      `SELECT CASE WHEN author_type = 'customer' THEN 'customer' WHEN auto THEN 'ai' WHEN author_id IS NOT NULL THEN 'human' ELSE 'support' END AS who,
              body, created_at
         FROM messages WHERE ticket_id = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT 'note', body, created_at FROM ticket_notes WHERE ticket_id = $1
       ORDER BY created_at
       LIMIT 300`,
      [ticketId],
    );
    return {
      channel: (t.rows[0].channel_type as string) ?? "email",
      subject: (t.rows[0].subject as string) ?? "",
      turns: m.rows.map((r) => ({ who: r.who as ReviewTurn["who"], body: (r.body as string) ?? "" })),
    };
  });
}

/** The documentation passages and help articles for one question, all visibilities, because only the team reads the review. */
async function sourcesFor(tenantId: string, search: string, collectionNames: Map<string, string>): Promise<ReviewSource[]> {
  const found = await findSources(tenantId, search, { limit: 20 }).catch(() => []);
  const docs = found.filter((f) => f.kind === "document").slice(0, DOC_SOURCES).flatMap((f) => (f.kind === "document" ? [{
    kind: "document" as const,
    id: f.item.id,
    title: f.item.filename ?? "Untitled page",
    url: f.item.source_key && /^https?:\/\//i.test(f.item.source_key) ? f.item.source_key : null,
    text: f.item.text,
  }] : []));
  const articles = found.filter((f) => f.kind === "kb").slice(0, ARTICLE_SOURCES).flatMap((f) => (f.kind === "kb" ? [{
    kind: "kb" as const,
    id: f.item.id,
    title: `${f.item.title} (${f.item.visibility}, ${f.item.collection_id ? collectionNames.get(f.item.collection_id) ?? "collection" : "no collection"})`,
    url: null,
    text: f.item.body,
  }] : []));
  return [...docs, ...articles];
}

type Usage = { tokensIn: number; tokensOut: number };

/** A failed review. Only a failure that the conversation causes, such as a reply out of format, uses up an attempt. */
export class ReviewFailure extends Error {
  constructor(message: string, readonly countsAttempt: boolean) {
    super(message);
  }
}

/** Ask the model and add its token counts to the review's total. A cut-off reply fails like a reply out of format. */
async function ask(driver: Awaited<ReturnType<typeof resolveModelDriver>>, system: string, user: string, usage: Usage): Promise<string> {
  try {
    return await driver.complete!(system, user, {
      timeoutMs: MODEL_TIMEOUT_MS,
      maxTokens: REVIEW_MAX_TOKENS,
      rejectTruncated: true,
      onUsage: (u) => {
        usage.tokensIn += u.tokensIn ?? 0;
        usage.tokensOut += u.tokensOut ?? 0;
      },
    });
  } catch (e) {
    const message = (e as Error).message ?? "the model failed";
    // A cut-off reply, a timeout and a request that the provider rejects fail again on a retry.
    // A rejected key, model id or rate is a setting, so it uses up no attempt.
    const status = Number(message.match(/^\w+ (4\d\d):/)?.[1] ?? 0);
    const timedOut = (e as Error).name === "AbortError" || /aborted/i.test(message);
    throw new ReviewFailure(message, /output limit/.test(message) || timedOut || (status >= 400 && ![401, 403, 404, 429].includes(status)));
  }
}

/**
 * Review one closed conversation and file its gaps. The caller has claimed the review in gap_reviews.
 * Throws a ReviewFailure when the model fails or answers out of format, so the claim records the error.
 */
export async function reviewConversation(tenantId: string, ticketId: string): Promise<{ conversation: ConversationKind; gaps: number }> {
  const driver = await resolveModelDriver(tenantId, { job: "general" });
  if (!driver.complete) throw new ReviewFailure("the workspace has no hosted model", false);
  const conv = await loadConversation(tenantId, ticketId);
  if (!conv) throw new ReviewFailure("the conversation is gone", true);
  const [company, docs, translation, collections, suggested] = await Promise.all([
    withTenant(tenantId, async (c) => (await c.query("SELECT name FROM tenants WHERE id = current_tenant()")).rows[0]?.name as string | undefined),
    getDocsSearchSettings(tenantId),
    getTranslationSettings(tenantId),
    withTenant(tenantId, async (c) => (await c.query("SELECT id, name FROM kb_collections ORDER BY position, name")).rows as Array<{ id: string; name: string }>),
    // Collections that earlier reviews suggested, so later reviews reuse a name instead of making up a close one.
    withTenant(tenantId, async (c) => (await c.query(
      "SELECT DISTINCT collection FROM knowledge_gaps WHERE status = 'open' AND kind = 'support_knowledge' AND collection IS NOT NULL",
    )).rows.map((r) => r.collection as string)),
  ]);
  const setup = { company: company || "the company", product: docs.product, language: localeName(translation.workspaceLocale) };
  const started = Date.now();
  const usage: Usage = { tokensIn: 0, tokensOut: 0 };
  const transcript = transcriptOf(conv.channel, conv.subject, conv.turns);

  const listed = parseQuestions(await ask(driver, questionsPrompt(setup), `<conversation>\n${transcript}\n</conversation>`, usage));
  if (!listed) throw new ReviewFailure("no question list in the answer", true);
  const collectionNames = new Map(collections.map((c) => [c.id, c.name]));
  const questions = await Promise.all(listed.questions.map(async (q) => ({ question: q.question, sources: await sourcesFor(tenantId, q.search, collectionNames) })));
  let reviews: GapReview[] = [];
  if (questions.length) {
    const parsed = parseReviews(await ask(driver, reviewPrompt(setup), reviewInput(transcript, questions, [...new Set([...collections.map((c) => c.name), ...suggested])]), usage));
    if (!parsed) throw new ReviewFailure("no reviews in the answer", true);
    reviews = parsed;
  }

  const gaps = await fileGaps(tenantId, ticketId, reviews, driver, usage);
  await withTenant(tenantId, (c) => c.query(
    "UPDATE gap_reviews SET conversation = $2, questions = $3, error = NULL WHERE ticket_id = $1",
    [ticketId, listed.conversation, JSON.stringify(reviews)],
  ));
  const first = conv.turns.find((t) => t.who === "customer")?.body ?? "";
  await recordGapReviewTrace({
    tenantId, ticketId, query: (conv.subject || first).slice(0, 500),
    review: { conversation: listed.conversation, questions: listed.questions, reviews },
    sources: questions.flatMap((q) => q.sources).map((s) => ({ kind: s.kind, id: s.id, title: s.title, url: s.url })),
    conversation: listed.conversation, gaps, model: driver.name, effort: driver.effort ?? null,
    tokensIn: usage.tokensIn || null, tokensOut: usage.tokensOut || null, latencyMs: Date.now() - started,
  });
  return { conversation: listed.conversation, gaps };
}

/**
 * Replace the conversation's questions in the gap list and return how many gaps it raised.
 * Each question joins the gap that asks the same thing, or starts a new one. A dismissed or resolved gap keeps its status.
 * Open gaps left without conversations are deleted last, so a re-review that finds the same question keeps its gap.
 */
async function fileGaps(
  tenantId: string,
  ticketId: string,
  reviews: GapReview[],
  driver: Awaited<ReturnType<typeof resolveModelDriver>>,
  usage: Usage,
): Promise<number> {
  const filed = reviews.filter((r) => isGapKind(r.kind));
  const known = await withTenant(tenantId, async (c) =>
    (await c.query(`SELECT id, question FROM knowledge_gaps ORDER BY (status = 'open') DESC, last_seen DESC LIMIT ${MATCH_GAPS}`)).rows as Array<{ id: string; question: string }>,
  );
  // Every match is decided before anything is written, so a failed call leaves the gap list as it was.
  // A question can also match a gap that an earlier question of this conversation is about to start.
  const options: Array<{ question: string; gapId: string | null; plan: number }> = known.map((g) => ({ question: g.question, gapId: g.id, plan: -1 }));
  const targets: typeof options = [];
  for (const r of filed) {
    let target: (typeof options)[number] | undefined;
    if (options.length) {
      // Short labels keep the prompt small and the reply easy to check.
      const labelled = options.map((o, i) => ({ id: `g${i + 1}`, question: o.question }));
      const match = parseMatch(await ask(driver, matchPrompt(), matchInput(r.question, labelled), usage), new Set(labelled.map((g) => g.id)));
      if (match === undefined) throw new ReviewFailure("no match in the answer", true);
      if (match) target = options[Number(match.slice(1)) - 1];
    }
    if (!target) {
      target = { question: r.question, gapId: null, plan: targets.length };
      options.push(target);
    }
    targets.push(target);
  }
  await withTenant(tenantId, async (c) => {
    const earlier = (await c.query("DELETE FROM knowledge_gap_questions WHERE ticket_id = $1 RETURNING gap_id", [ticketId])).rows.map((r) => r.gap_id as string);
    const started = new Map<number, string>();
    const touched: string[] = [];
    for (const [i, r] of filed.entries()) {
      const t = targets[i];
      const page = validUrl(r.page);
      let gapId = t.gapId ?? started.get(t.plan) ?? null;
      if (!gapId) {
        const g = await c.query(
          "INSERT INTO knowledge_gaps (tenant_id, question, kind, page_url, collection) VALUES (current_tenant(), $1, $2, $3, $4) RETURNING id",
          [r.question, r.kind, page, r.collection],
        );
        gapId = g.rows[0].id as string;
        started.set(t.plan, gapId);
      }
      await c.query(
        `INSERT INTO knowledge_gap_questions (tenant_id, gap_id, ticket_id, question, kind, answer, page_url, article_id, suggestion, title, collection)
         VALUES (current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [gapId, ticketId, r.question, r.kind, r.answer, page, validUuid(r.article), r.suggestion, r.title, r.collection],
      );
      await c.query(
        "UPDATE knowledge_gaps SET page_url = COALESCE(page_url, $2), collection = COALESCE(collection, $3), last_seen = now() WHERE id = $1",
        [gapId, page, r.collection],
      );
      touched.push(gapId);
    }
    await recountGaps(c, [...new Set([...touched, ...earlier])]);
  });
  return filed.length;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validUuid = (v: string | null) => (v && UUID.test(v) ? v : null);
const validUrl = (v: string | null) => (v && /^https?:\/\/\S+$/i.test(v) ? v : null);

/** Count each gap's conversations again, and delete an open gap that has none left. */
async function recountGaps(c: { query: (sql: string, params: unknown[]) => Promise<unknown> }, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await c.query(
    `UPDATE knowledge_gaps g SET occurrences = (SELECT count(DISTINCT ticket_id) FROM knowledge_gap_questions q WHERE q.gap_id = g.id)
      WHERE g.id = ANY($1::uuid[])`,
    [ids],
  );
  await c.query(
    "DELETE FROM knowledge_gaps g WHERE g.id = ANY($1::uuid[]) AND g.status = 'open' AND NOT EXISTS (SELECT 1 FROM knowledge_gap_questions q WHERE q.gap_id = g.id)",
    [ids],
  );
}

/**
 * Claim a due review, so another api instance skips it. Returns false when someone else claimed it first.
 * A changed conversation starts its attempts again, and a cut-off review counts as one.
 */
async function claimReview(tenantId: string, ticketId: string, closedAt: Date): Promise<boolean> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO gap_reviews (tenant_id, ticket_id, attempts) VALUES (current_tenant(), $1, 0)
       ON CONFLICT (tenant_id, ticket_id) DO UPDATE
         SET reviewed_at = now(), conversation = NULL, error = NULL,
             failures = CASE WHEN ${CHANGED_SQL("gap_reviews", "$2", "gap_reviews.tenant_id", "$1")} THEN 0 ELSE gap_reviews.failures END,
             attempts = CASE WHEN ${CHANGED_SQL("gap_reviews", "$2", "gap_reviews.tenant_id", "$1")} THEN 0
                             WHEN gap_reviews.conversation IS NULL AND gap_reviews.error IS NULL THEN gap_reviews.attempts + 1
                             ELSE gap_reviews.attempts END
       WHERE ${DUE_SQL("gap_reviews", "$2", "gap_reviews.tenant_id", "$1")}
       RETURNING ticket_id`,
      [ticketId, closedAt],
    );
    return (r.rowCount ?? 0) > 0;
  });
}

/** Whether a conversation closed again after review row `r`, with a new message since. Closing a closed ticket again changes nothing. */
const CHANGED_SQL = (r: string, closedAt: string, tenant: string, ticket: string) => `(${r}.reviewed_at < ${closedAt}
  AND EXISTS (SELECT 1 FROM messages m WHERE m.tenant_id = ${tenant} AND m.ticket_id = ${ticket} AND m.created_at > ${r}.reviewed_at))`;

/** Whether review row `r` is due again: the conversation changed, a failed review waited long enough, or a review was cut off. */
const DUE_SQL = (r: string, closedAt: string, tenant: string, ticket: string) => `(${CHANGED_SQL(r, closedAt, tenant, ticket)}
  OR (${r}.error IS NOT NULL AND ${r}.attempts < ${MAX_ATTEMPTS} AND ${r}.failures < ${MAX_FAILURES} AND ${r}.reviewed_at < now() - interval '${RETRY_AFTER}')
  OR (${r}.conversation IS NULL AND ${r}.error IS NULL AND ${r}.attempts < ${MAX_ATTEMPTS} AND ${r}.reviewed_at < now() - interval '${STALE_REVIEW}'))`;

let sweepRunning = false;

/**
 * Review the conversations that closed a while ago in the workspaces that switched the review on.
 * Each workspace takes its oldest unreviewed conversations first and retries last, and the workspaces take turns.
 * Only conversations where a customer wrote are reviewed. A workspace without a hosted model is skipped without a claim.
 */
export async function runGapReviewSweep(log?: { info?: (o: object, m: string) => void; error?: (o: object, m: string) => void }): Promise<void> {
  if (sweepRunning) return;
  sweepRunning = true;
  try {
    const due = await relayPool.query(
      `SELECT tenant_id, id, closed_at FROM (
         SELECT t.tenant_id, t.id, t.closed_at, row_number() OVER (PARTITION BY t.tenant_id ORDER BY (r.ticket_id IS NOT NULL), t.closed_at) AS n
           FROM tickets t
           JOIN gap_settings s ON s.tenant_id = t.tenant_id AND s.enabled
           LEFT JOIN gap_reviews r ON r.tenant_id = t.tenant_id AND r.ticket_id = t.id
          WHERE t.status = 'closed' AND t.spam_at IS NULL AND t.merged_into IS NULL
            AND t.closed_at < now() - interval '${REVIEW_DELAY}' AND t.closed_at > now() - interval '${REVIEW_WINDOW}'
            AND EXISTS (SELECT 1 FROM messages m WHERE m.tenant_id = t.tenant_id AND m.ticket_id = t.id AND m.author_type = 'customer')
            AND (r.ticket_id IS NULL OR ${DUE_SQL("r", "t.closed_at", "t.tenant_id", "t.id")})
       ) due
       WHERE n <= ${REVIEWS_PER_WORKSPACE}
       ORDER BY n, random()`,
    );
    // A workspace whose model fails in this sweep waits for the next one.
    const skip = new Set<string>();
    let started = 0;
    for (const row of due.rows) {
      const tenantId = row.tenant_id as string;
      const ticketId = row.id as string;
      if (started >= REVIEWS_PER_SWEEP) break;
      if (skip.has(tenantId)) continue;
      if (!(await resolveModelDriver(tenantId, { job: "general" })).complete) {
        skip.add(tenantId);
        continue;
      }
      if (!(await claimReview(tenantId, ticketId, row.closed_at as Date))) continue;
      started++;
      try {
        const res = await reviewConversation(tenantId, ticketId);
        log?.info?.({ ticketId, ...res }, "gap review");
      } catch (e) {
        const counts = e instanceof ReviewFailure ? e.countsAttempt : true;
        if (!counts) skip.add(tenantId);
        log?.error?.({ err: e, ticketId }, "gap review failed");
        await withTenant(tenantId, (c) => c.query(
          "UPDATE gap_reviews SET error = $2, attempts = attempts + $3, failures = failures + 1 WHERE ticket_id = $1",
          [ticketId, ((e as Error).message || "the review failed").slice(0, 300), counts ? 1 : 0],
        )).catch((err) => log?.error?.({ err, ticketId }, "gap review error not saved"));
      }
    }
  } catch (e) {
    log?.error?.({ err: e }, "gap review sweep failed");
  } finally {
    sweepRunning = false;
  }
}
