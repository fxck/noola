import { withTenant } from "@repo/db";
import { modelDriver, embeddingDriver, clip, type DraftResult, type DraftTurn, type DraftImage, type ModelServingDriver } from "./model.js";
import { resolveModelDriver } from "./modelconfig.js";
import { personaFragment } from "./persona.js";
import { searchArticles, hydrateArticles } from "./kb.js";
import { searchDocuments, listDocuments, hydrateChunks } from "./documents.js";
import { hasOutcomeTag, parseDraftOutcome } from "./ai-outcome.js";
import { searchResolvedThreads, hydrateThreads } from "./threads.js";
import { vectorSearch, type VectorCollection } from "./vector.js";
import { recordDraftTrace } from "./trace.js";
import { isContentGap, recordKnowledgeGap } from "./gaps.js";
import { searchQueryFor } from "./docs-search.js";

// Copilot: the retrieval-augmented suggested reply. Given a ticket (or a bare
// query, for eval), it takes the latest customer message, retrieves the most
// relevant KB articles, resolved threads, and document passages (tenant-scoped,
// hybrid keyword+vector), and asks the model driver to draft a grounded reply. The
// retrieval CORE is factored into suggestForQuery() so the /suggest endpoint, the
// autoreply gate, and the eval harness all share one path — and every call records
// a draft_trace. The agent (or the gate) decides whether to send; this only drafts.

const MAX_ARTICLES = 2;
const MAX_THREADS = 2;
const MAX_CHUNKS = 3;
// Cosine floor for the vector arm — below this a "match" is noise (all-MiniLM scores
// unrelated pairs well under this). Keeps semantic matches, drops nearest-but-far
// neighbours so retrieval `agreement` means something for the autoreply gate.
const VEC_FLOOR = 0.3;

// Filler/greeting/question words carry no retrieval signal. Keyword search ANDs
// its tokens, so a raw sentence ("Hi, I have a question about your refund policy")
// forces the corpus to contain every filler word and finds nothing. We reduce the
// message to its content words before retrieving. (The vector arm handles semantics;
// this keeps the keyword arm from zeroing out on natural-language phrasing.)
const STOP = new Set(
  ("a an and or but so the this that these those is are was were be been being have has had do does did " +
   "i we you your yours my me our us they them it its of on in to for from with about as at by " +
   "hi hello hey thanks thank please can could would should will just want need help question " +
   "how what when where which who why not no yes get got there here any some more most very")
    .split(" "),
);

/** Reduce free text to distinctive content words, longest (most specific) first. */
export function keywords(text: string): string[] {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const kept = words.filter((w) => w.length > 2 && !STOP.has(w));
  return [...new Set(kept)].sort((a, b) => b.length - a.length);
}

/**
 * Keyword retrieval that tolerates natural-language questions. Try the precise
 * conjunction of all content words first; if it finds nothing (the corpus rarely
 * contains every word), relax to the most distinctive single terms in turn. Extra
 * calls happen only on a miss. `search` is the tenant-scoped ranker (KB or chunks).
 */
async function retrieve<T>(
  search: (q: string) => Promise<T[]>,
  message: string,
  textOf: (item: T) => string,
): Promise<T[]> {
  const kw = keywords(message);
  if (kw.length === 0) return search(message).catch(() => []);
  const precise = await search(kw.join(" ")).catch(() => []);
  if (precise.length) return precise;
  for (const term of kw) {
    const hits = await search(term).catch(() => []);
    const solid = hits.filter((h) => textOf(h).toLowerCase().includes(term));
    if (solid.length) return solid;
  }
  return [];
}

/**
 * Reciprocal-rank fusion: combine several ranked lists into one, scoring each item
 * by Σ 1/(k+rank). Items ranked highly by BOTH the keyword and the vector ranker
 * float to the top. Returns the fused order AND the per-id score map — the autoreply
 * gate and the trace store need the scores, not just the order.
 */
function rrfMerge<T>(
  lists: T[][],
  idOf: (t: T) => string,
  k = 60,
): { items: T[]; scores: Map<string, number> } {
  const scores = new Map<string, number>();
  const seen = new Map<string, T>();
  for (const list of lists) {
    list.forEach((item, rank) => {
      const id = idOf(item);
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
      if (!seen.has(id)) seen.set(id, item);
    });
  }
  const items = [...seen.keys()]
    .sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0))
    .map((id) => seen.get(id)!);
  return { items, scores };
}

/** Where each search ranked a source, from 1. A search that didn't find the source leaves its rank out. */
export interface SearchRanks {
  keyword?: number;
  meaning?: number;
  /** With a search query, whether the query, the customer's message or both found the source. */
  foundBy?: "query" | "message" | "both";
}

interface Ranked<T> {
  items: T[];
  scores: Map<string, number>;
  ranks: Map<string, SearchRanks>;
}

/**
 * Hybrid retrieval for one knowledge surface: run the keyword ranker (Typesense)
 * and the vector ranker (Qdrant) in parallel, then RRF-fuse. A null query vector
 * (embedder down) degrades to keyword-only. Returns fused items + fused scores, and each search's rank for the trace.
 */
async function hybrid<T>(
  keyword: () => Promise<T[]>,
  collection: VectorCollection,
  tenantId: string,
  queryVector: number[] | null,
  hydrate: (ids: string[]) => Promise<T[]>,
  idOf: (t: T) => string,
): Promise<Ranked<T>> {
  const [kw, vec] = await Promise.all([
    keyword(),
    queryVector
      ? vectorSearch(collection, tenantId, queryVector, 20, VEC_FLOOR).then(hydrate).catch(() => [])
      : Promise.resolve<T[]>([]),
  ]);
  const ranks = new Map<string, SearchRanks>();
  vec.forEach((item, i) => ranks.set(idOf(item), { meaning: i + 1 }));
  kw.forEach((item, i) => ranks.set(idOf(item), { keyword: i + 1, ...ranks.get(idOf(item)) }));
  return { ...rrfMerge([vec, kw], idOf), ranks };
}

/**
 * The search query's results ranked ahead of the message's own, which count at half weight for the order only.
 * The scores stay unhalved, so the gate and the gap detector see how well the docs actually matched.
 */
export function mergeQueryRuns<T>(query: Ranked<T>, message: Ranked<T>, idOf: (t: T) => string): Ranked<T> {
  const halved = new Map([...message.scores].map(([id, score]) => [id, score / 2]));
  const { items } = mergeBest(query, { items: message.items, scores: halved }, idOf);
  // A source that both runs found shows the ranks of the run that gave its score.
  const ranks = new Map<string, SearchRanks>();
  for (const [id, r] of message.ranks) ranks.set(id, { ...r, foundBy: "message" });
  for (const [id, r] of query.ranks) {
    const fromMessage = ranks.get(id);
    const better = fromMessage && (message.scores.get(id) ?? 0) > (query.scores.get(id) ?? 0) ? fromMessage : r;
    ranks.set(id, { ...better, foundBy: fromMessage ? "both" : "query" });
  }
  return { items, scores: mergeBest(query, message, idOf).scores, ranks };
}

/** Two retrievals of one surface, each item at its better score. A score is never summed across them, so the gate's thresholds keep their meaning. */
export function mergeBest<T>(
  a: { items: T[]; scores: Map<string, number> },
  b: { items: T[]; scores: Map<string, number> },
  idOf: (t: T) => string,
): { items: T[]; scores: Map<string, number> } {
  const scores = new Map(a.scores);
  for (const [id, score] of b.scores) scores.set(id, Math.max(score, scores.get(id) ?? 0));
  const seen = new Map<string, T>();
  for (const item of [...a.items, ...b.items]) if (!seen.has(idOf(item))) seen.set(idOf(item), item);
  const items = [...seen.values()].sort((x, y) => (scores.get(idOf(y)) ?? 0) - (scores.get(idOf(x)) ?? 0));
  return { items, scores };
}

export interface Citation {
  kind: "kb" | "document" | "thread";
  id: string;
  title: string;
  snippet: string;
  /** Absolute source URL when the citation has a canonical page (url-connector documents). Lets the
   *  answer/UI link to the real source with its domain. Undefined for KB, threads, manual uploads. */
  url?: string;
}

/** The signals the autoreply gate reads: how many distinct source kinds corroborate,
 *  the top fused score, and each citation's fused score. Scores are unnormalized RRF
 *  (~1/61 per contributing list), so `agreement` is the primary gate, score secondary. */
export interface RetrievalSummary {
  topScore: number;
  citedKinds: ("kb" | "thread" | "document")[];
  agreement: number;
  perCitation: { kind: "kb" | "thread" | "document"; id: string; score: number }[];
}

export interface Suggestion {
  draft: string;
  citations: Citation[];
  model: string;
  /** The customer text the retrieval ran against — surfaced so the agent sees why. */
  basedOn: string | null;
  retrieval: RetrievalSummary;
  confidence: number | null;
  traceId: string | null;
  /** Draft telemetry surfaced to the client (nerd-stats). tokensIn/out are null for the
   *  rule baseline (extractive, no LLM); a hosted driver reports usage. latencyMs is the
   *  wall-clock around the draft call. */
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number;
  /** The draft may hold the outcome tags of ai-outcome.ts. Only a hosted model asked for them sets it. */
  outcomes?: boolean;
}

/** The latest inbound customer message drives retrieval — it's what we're answering. */
async function latestCustomerMessage(tenantId: string, ticketId: string): Promise<string | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT body FROM messages
        WHERE ticket_id = $1 AND author_type = 'customer'
        ORDER BY created_at DESC LIMIT 1`,
      [ticketId],
    );
    return r.rowCount ? (r.rows[0].body as string) : null;
  });
}

/** Who the answer is FOR. 'public' = anonymous surfaces (widget, docs embed, deflection,
 *  public answer API); 'agent' = the copilot + autoreply gate. Retrieval scoping (item 18)
 *  keys on this: public answers ground on the KB + your indexed documents (the docs you
 *  crawled/uploaded to answer customers), but NEVER on resolved customer threads — so a prior
 *  customer's conversation can't leak into an anonymous answer. Only agents see the thread surface. */
export type Audience = "public" | "agent";

export const DEFAULT_SCOPES: Record<Audience, string[]> = {
  public: ["kb", "document"],
  agent: ["kb", "thread", "document"],
};

/** The tenant's configured retrieval scope for an audience (autoreply_policy.source_scopes),
 *  falling back to the safe defaults. Returned as a Set of source kinds to retrieve. */
export async function audienceScope(tenantId: string, audience: Audience): Promise<Set<string>> {
  const configured = await withTenant(tenantId, async (c) => {
    const r = await c.query("SELECT source_scopes FROM autoreply_policy WHERE tenant_id = current_tenant()");
    return r.rowCount ? (r.rows[0].source_scopes as Record<string, string[]>) : {};
  }).catch(() => ({}) as Record<string, string[]>);
  const kinds = Array.isArray(configured?.[audience]) && configured[audience].length > 0
    ? configured[audience]
    : DEFAULT_SCOPES[audience];
  return new Set(kinds);
}

export interface SuggestOpts {
  ticketId?: string | null;
  messageId?: string | null;
  source?: "live" | "eval";
  /** Retrieval-scoping audience; defaults to 'agent' (full retrieval). */
  audience?: Audience;
  /** Hard override for the retrieval scope, bypassing the tenant's audienceScope entirely. The
   *  on-demand public /ask passes ['kb'] to re-assert KB-only at the command layer regardless of
   *  how the tenant widened its public source_scopes (§5.3 #2). */
  forceScope?: string[];
  /** Images the customer attached to the message being answered (widget screenshots, error shots).
   *  Passed straight to the vision-capable hosted model as image content-blocks so the draft accounts
   *  for what they showed. Retrieval is unaffected — grounding still comes from the text query — and
   *  the rule baseline ignores them. */
  images?: DraftImage[];
  /** The ambient autoreply and the widget let a hosted model add a note for the team or decide that no reply is needed. */
  outcomes?: boolean;
}

const EXCERPT_CHARS = 240;

function rankFields(r: SearchRanks | undefined): { keywordRank?: number; meaningRank?: number; foundBy?: SearchRanks["foundBy"] } {
  return { keywordRank: r?.keyword, meaningRank: r?.meaning, foundBy: r?.foundBy };
}

const EMPTY_RETRIEVAL: RetrievalSummary = { topScore: 0, citedKinds: [], agreement: 0, perCitation: [] };

/**
 * The shared retrieval+draft+trace core. Given a raw query (no ticket lookup), it
 * runs hybrid retrieval across all three surfaces, drafts through the tenant's model
 * driver (BYO hosted or the rule baseline, with graceful fallback), records a
 * draft_trace, and returns the suggestion + retrieval signals. Used by the /suggest
 * endpoint, the autoreply gate, and the eval harness — one path, one trace per draft.
 */
export async function suggestForQuery(
  tenantId: string,
  query: string,
  opts: SuggestOpts = {},
): Promise<Suggestion> {
  const started = Date.now();
  const source = opts.source ?? "live";
  const ticketId = opts.ticketId ?? null;
  const messageId = opts.messageId ?? null;

  // No customer text to answer → a safe acknowledgement, no retrieval.
  if (!query || !query.trim()) {
    const draftStarted = Date.now();
    const r = await modelDriver.draftReply({ customerMessage: "", sources: [] });
    const latencyMs = Date.now() - draftStarted;
    const traceId = await recordDraftTrace({
      tenantId, ticketId, messageId, query: query ?? "", sources: [], retrieval: EMPTY_RETRIEVAL,
      draft: r.text, model: modelDriver.name, embedModel: embeddingDriver.name,
      confidence: r.confidence ?? null, tokensIn: r.tokensIn ?? null, tokensOut: r.tokensOut ?? null,
      latencyMs: Date.now() - started, source,
    });
    return {
      draft: r.text, citations: [], model: modelDriver.name, basedOn: null,
      retrieval: EMPTY_RETRIEVAL, confidence: r.confidence ?? null, traceId,
      tokensIn: r.tokensIn ?? null, tokensOut: r.tokensOut ?? null, latencyMs,
    };
  }

  const prep = await prepareDraft(tenantId, query, opts, started);
  // A public answer with no sources gets the fixed deflection.
  // A hosted model that can tag its answer may answer instead, if safeWithoutSources accepts it.
  const ungrounded = opts.audience === "public" && prep.groundingCount === 0;
  const deflect = () => prep.finalize({ text: PUBLIC_NO_GROUNDING_DEFLECTION, confidence: 0 }, "grounding-guard", 0);
  if (ungrounded && !prep.answersWithoutSources) return deflect();
  const draftStarted = Date.now();
  let result: DraftResult;
  let model: string;
  try {
    result = await prep.driver.draftReply(prep.draftInput);
    model = prep.driver.name;
  } catch {
    if (ungrounded) return deflect();
    result = await modelDriver.draftReply(prep.draftInput);
    model = `${modelDriver.name} (fallback)`;
  }
  if (ungrounded && !safeWithoutSources(result.text)) return deflect();
  return prep.finalize(result, model, Date.now() - draftStarted);
}

/** Streaming sibling of suggestForQuery. Runs the identical retrieval + grounding, then
 *  streams the draft token-by-token (yielding `{ delta }`), and RETURNS the same fully-
 *  formed Suggestion (trace + citations + gap detection) once generation completes — so
 *  the SSE endpoint gets live tokens AND the canonical persisted answer from one call. */
export async function* suggestForQueryStream(
  tenantId: string,
  query: string,
  opts: SuggestOpts = {},
): AsyncGenerator<{ delta: string }, Suggestion, void> {
  const started = Date.now();
  // No customer text → stream the safe acknowledgement whole (no retrieval), matching the
  // non-streaming path's early return.
  if (!query || !query.trim()) {
    const suggestion = await suggestForQuery(tenantId, query, opts);
    yield { delta: suggestion.draft };
    return suggestion;
  }

  const prep = await prepareDraft(tenantId, query, opts, started);
  // A public answer with no sources is drafted whole and checked before anything reaches the customer.
  if (opts.audience === "public" && prep.groundingCount === 0) {
    const draftStarted = Date.now();
    const dr = prep.answersWithoutSources ? await prep.driver.draftReply(prep.draftInput).catch(() => null) : null;
    if (!dr || !safeWithoutSources(dr.text)) {
      yield { delta: PUBLIC_NO_GROUNDING_DEFLECTION };
      return prep.finalize({ text: PUBLIC_NO_GROUNDING_DEFLECTION, confidence: 0 }, "grounding-guard", 0);
    }
    yield { delta: dr.text };
    return prep.finalize(dr, prep.driver.name, Date.now() - draftStarted);
  }
  const draftStarted = Date.now();
  let text = "";
  let dr: DraftResult | null = null;
  let model = prep.driver.name;

  if (prep.driver.draftReplyStream) {
    try {
      for await (const ev of prep.driver.draftReplyStream(prep.draftInput)) {
        if (ev.delta) {
          text += ev.delta;
          yield { delta: ev.delta };
        }
        if (ev.done) dr = ev.done;
      }
    } catch {
      // A stream that fails AFTER emitting text can't be un-sent — keep what the client
      // already has. Only a stream that produced nothing falls through to a fresh draft.
      if (text) dr = { text, confidence: 0.7, outcomes: prep.draftInput.outcomes === true };
    }
  }
  if (!dr && !text) {
    // Streaming unsupported or produced nothing → non-stream draft, degrade to baseline.
    try {
      dr = await prep.driver.draftReply(prep.draftInput);
    } catch {
      dr = await modelDriver.draftReply(prep.draftInput);
      model = `${modelDriver.name} (fallback)`;
    }
    text = dr.text;
    yield { delta: dr.text };
  } else if (!dr) {
    dr = { text, confidence: 0.7, outcomes: prep.draftInput.outcomes === true };
  }

  return prep.finalize(dr, model, Date.now() - draftStarted);
}

/** Recent conversation turns for a ticket (oldest→newest) to give the hosted draft context — so a
 *  follow-up sees the prior messages instead of answering blind. Excludes the triggering message
 *  (that's the `query`) and empty bodies, keeps only customer/agent turns, and caps at the last N so
 *  the prompt stays bounded. Best-effort: history is an enhancement, a load failure never blocks a draft. */
async function loadHistory(
  tenantId: string,
  ticketId: string,
  excludeMessageId: string | null,
  limit = 10,
): Promise<DraftTurn[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT author_type, body FROM messages
         WHERE ticket_id = $1
           AND ($2::text IS NULL OR id::text <> $2::text)
           AND author_type IN ('customer','agent')
           AND coalesce(btrim(body), '') <> ''
         ORDER BY created_at DESC
         LIMIT $3`,
      [ticketId, excludeMessageId, limit],
    );
    return (r.rows as Array<{ author_type: string; body: string }>)
      .reverse()
      .map((m) => ({ role: m.author_type === "agent" ? "agent" : "customer", text: m.body }) as DraftTurn);
  });
}

/** The shared retrieval + grounding + driver-resolution used by both the blocking and the
 *  streaming entry points. Returns the ready-to-call draft input plus a `finalize` closure
 *  that records the trace, runs content-gap detection, and assembles the Suggestion once a
 *  DraftResult exists (however it was produced — one shot or streamed). */
async function prepareDraft(
  tenantId: string,
  query: string,
  opts: SuggestOpts,
  started: number,
): Promise<{
  driver: ModelServingDriver;
  draftInput: { customerMessage: string; sources: Array<{ title: string; text: string }>; persona: string; history: DraftTurn[]; images?: DraftImage[]; outcomes?: boolean };
  citations: Citation[];
  retrieval: RetrievalSummary;
  /** Number of grounding passages retrieved in-scope. Zero on a public answer means the model has nothing to ground on,
   *  so the entry points deflect unless the model's answer states nothing (safeWithoutSources). */
  groundingCount: number;
  /** A hosted model asked for answer tags can answer without sources, as it can skip a thank-you or ask what the customer needs. */
  answersWithoutSources: boolean;
  finalize: (result: DraftResult, model: string, latencyMs: number) => Promise<Suggestion>;
}> {
  const source = opts.source ?? "live";
  const ticketId = opts.ticketId ?? null;
  const messageId = opts.messageId ?? null;

  // Embed the query once (all three surfaces share the vector), then retrieve each
  // IN-SCOPE surface with hybrid keyword+vector fusion. Tenant-scoped throughout. The
  // audience scope (item 18) drops whole surfaces: public answers default to KB only.
  const scope = opts.forceScope
    ? new Set(opts.forceScope)
    : await audienceScope(tenantId, opts.audience ?? "agent");
  const NONE = { items: [] as never[], scores: new Map<string, number>(), ranks: new Map<string, SearchRanks>() };
  const retrieveAll = async (text: string) => {
    const queryVector = (await embeddingDriver.embed([text]))?.[0] ?? null;
    return Promise.all([
      scope.has("kb")
        ? hybrid(
            () => retrieve((q) => searchArticles(tenantId, q), text, (a) => `${a.title} ${a.body}`),
            "kb", tenantId, queryVector, (ids) => hydrateArticles(tenantId, ids), (a) => a.id,
          )
        : Promise.resolve(NONE),
      scope.has("thread")
        ? hybrid(
            () => retrieve((q) => searchResolvedThreads(tenantId, q), text, (t) => `${t.subject} ${t.text}`),
            "threads", tenantId, queryVector, (ids) => hydrateThreads(tenantId, ids), (t) => t.ticket_id,
          )
        : Promise.resolve(NONE),
      scope.has("document")
        ? hybrid(
            () => retrieve((q) => searchDocuments(tenantId, q), text, (ch) => ch.text),
            "chunks", tenantId, queryVector, (ids) => hydrateChunks(tenantId, ids), (ch) => ch.id,
          )
        : Promise.resolve(NONE),
    ]);
  };
  // Conversation history (best-effort) so the draft is context-aware — a follow-up must see the
  // prior turns, not answer blind. Ticket-scoped; a bare query (raw /suggest, eval) → no history.
  const history = ticketId ? await loadHistory(tenantId, ticketId, messageId).catch(() => []) : [];
  // A model-written search query matches the docs better than a long or foreign message, so its results lead.
  const [original, searchQuery] = await Promise.all([
    retrieveAll(query),
    searchQueryFor(tenantId, query, history).catch(() => null),
  ]);
  let [artR, thrR, chkR] = original;
  if (searchQuery) {
    const [art2, thr2, chk2] = await retrieveAll(searchQuery);
    artR = mergeQueryRuns(art2, artR, (a) => a.id);
    thrR = mergeQueryRuns(thr2, thrR, (t) => t.ticket_id);
    chkR = mergeQueryRuns(chk2, chkR, (ch) => ch.id);
  }

  const kbTop = artR.items.slice(0, MAX_ARTICLES);
  const threadTop = thrR.items.slice(0, MAX_THREADS);
  const chunkTop = chkR.items.slice(0, MAX_CHUNKS);

  // Resolve chunk → document filename for citation (one list, mapped).
  const docNames = new Map<string, string>();
  if (chunkTop.length > 0) {
    const docs = await listDocuments(tenantId).catch(() => []);
    for (const d of docs) docNames.set(d.id, d.filename);
  }
  // Chunk → absolute source URL, straight off the hit's source_key (url-connector docs only — a
  // page URL with domain). Guarded to http(s) so a manual upload (null) or a github repo path
  // never becomes a bogus link.
  const docUrls = new Map<string, string>();
  for (const ch of chunkTop) {
    if (ch.source_key && /^https?:\/\//i.test(ch.source_key)) docUrls.set(ch.document_id, ch.source_key);
  }

  const kbSources: Citation[] = kbTop.map((a) => ({
    kind: "kb", id: a.id, title: a.title, snippet: clip(a.body, 180),
  }));
  const threadSources: Citation[] = threadTop.map((t) => ({
    kind: "thread", id: t.ticket_id, title: `Resolved: ${t.subject}`, snippet: clip(t.text, 180),
  }));
  const docSources: Citation[] = chunkTop.map((ch) => ({
    kind: "document", id: ch.document_id, title: docNames.get(ch.document_id) ?? "Document", snippet: clip(ch.text, 180),
    url: docUrls.get(ch.document_id),
  }));
  // Rank order: authored KB answers, then how we actually answered before (resolved
  // threads), then raw document passages.
  const citations = [...kbSources, ...threadSources, ...docSources];

  // Per-citation fused scores → the retrieval summary the gate reads.
  const perCitation: RetrievalSummary["perCitation"] = [
    ...kbTop.map((a) => ({ kind: "kb" as const, id: a.id, score: artR.scores.get(a.id) ?? 0 })),
    ...threadTop.map((t) => ({ kind: "thread" as const, id: t.ticket_id, score: thrR.scores.get(t.ticket_id) ?? 0 })),
    ...chunkTop.map((ch) => ({ kind: "document" as const, id: ch.id, score: chkR.scores.get(ch.id) ?? 0 })),
  ];
  // What the trace viewer shows per source, in the order of perCitation.
  const traceDetails = [
    ...kbTop.map((a) => ({ ...rankFields(artR.ranks.get(a.id)), excerpt: clip(a.body, EXCERPT_CHARS) })),
    ...threadTop.map((t) => ({ ...rankFields(thrR.ranks.get(t.ticket_id)), excerpt: clip(t.text, EXCERPT_CHARS) })),
    ...chunkTop.map((ch) => ({
      ...rankFields(chkR.ranks.get(ch.id)), excerpt: clip(ch.text, EXCERPT_CHARS), passage: ch.chunk_index, passages: ch.chunk_count,
    })),
  ];
  const citedKinds = [...new Set(perCitation.map((p) => p.kind))];
  const retrieval: RetrievalSummary = {
    topScore: perCitation.reduce((m, p) => Math.max(m, p.score), 0),
    citedKinds,
    agreement: citedKinds.length,
    perCitation,
  };

  // Grounding text: fuller passages than the display snippets. Round-robin the three
  // sources so the draft draws from a DIVERSE set — the model only uses the top
  // couple, and we don't want two loose KB hits to crowd out a strong thread answer.
  const bySource: Array<Array<{ title: string; text: string; url?: string }>> = [
    kbTop.map((a) => ({ title: a.title, text: a.body })),
    threadTop.map((t) => ({ title: `Resolved: ${t.subject}`, text: t.text })),
    chunkTop.map((ch) => ({ title: docNames.get(ch.document_id) ?? "Document", text: ch.text, url: docUrls.get(ch.document_id) })),
  ];
  const grounding: Array<{ title: string; text: string; url?: string }> = [];
  for (let i = 0; i < Math.max(0, ...bySource.map((s) => s.length)); i++) {
    for (const src of bySource) if (src[i]) grounding.push(src[i]);
  }

  // Draft through the tenant's configured model (BYO hosted LLM, or the extractive
  // rule baseline). Degrade to the baseline on hosted-model failure rather than 502.
  const driver = await resolveModelDriver(tenantId);
  // The tenant's configured voice (persona.ts) steers the hosted draft; empty/unconfigured is a
  // no-op. Best-effort — a persona lookup failure must never block a draft.
  const persona = await personaFragment(tenantId).catch(() => "");
  // Current-turn images (widget screenshots) ride along to a vision model as image content-blocks —
  // extra context on TOP of the text-driven retrieval, never a substitute for grounding.
  const draftInput = { customerMessage: query, sources: grounding, persona, history, images: opts.images, outcomes: opts.outcomes };

  // Trace + content-gap + Suggestion assembly, invoked once a DraftResult exists (one-shot
  // or streamed). `latencyMs` is the draft-generation time the caller measured.
  const finalize = async (result: DraftResult, model: string, latencyMs: number): Promise<Suggestion> => {
    const traceSources = perCitation.map((p, i) => ({
      kind: p.kind, id: p.id, title: citations[i]?.title ?? "", score: p.score, rank: i,
      ...(p.kind === "document" ? { documentId: citations[i]?.id, url: citations[i]?.url } : {}),
      ...traceDetails[i],
    }));
    const traceId = await recordDraftTrace({
      tenantId, ticketId, messageId, query, searchQuery, sources: traceSources, retrieval,
      draft: result.text, model, embedModel: embeddingDriver.name,
      confidence: result.confidence ?? null, tokensIn: result.tokensIn ?? null,
      tokensOut: result.tokensOut ?? null, latencyMs: Date.now() - started, source,
    });
    // Content-gap detection: weak retrieval means the KB couldn't answer this — record it
    // (clustered, best-effort) so it surfaces in the Sources worklist and routes back to authoring.
    // A message the model chose not to answer, such as a thank-you, asked nothing the docs could miss.
    const parsed = result.outcomes === true && hasOutcomeTag(result.text) ? parseDraftOutcome(result.text) : null;
    const noReply = parsed?.kind === "ok" && parsed.noReply;
    if (isContentGap(retrieval.agreement, retrieval.topScore) && !noReply) {
      void recordKnowledgeGap(tenantId, {
        query, confidence: result.confidence ?? null, topScore: retrieval.topScore,
        agreement: retrieval.agreement, source, ticketId,
      });
    }
    return {
      draft: result.text, citations, model, basedOn: clip(query, 160),
      retrieval, confidence: result.confidence ?? null, traceId,
      tokensIn: result.tokensIn ?? null, tokensOut: result.tokensOut ?? null, latencyMs,
      outcomes: result.outcomes === true,
    };
  };

  const answersWithoutSources = draftInput.outcomes === true && typeof driver.complete === "function";
  return { driver, draftInput, citations, retrieval, groundingCount: grounding.length, answersWithoutSources, finalize };
}

// Longer than this, a reply without sources is explaining something, which it has nothing to base on.
const UNGROUNDED_REPLY_MAX = 400;

/**
 * Whether an answer written without sources is safe to send: it states nothing about the product.
 * That is no reply, a note for the team alone, or a short reply that asks a question or hands off.
 */
export function safeWithoutSources(draft: string): boolean {
  const parsed = hasOutcomeTag(draft) ? parseDraftOutcome(draft) : { kind: "ok" as const, reply: draft.trim(), noReply: false, handoff: false };
  if (parsed.kind !== "ok") return false;
  if (parsed.noReply || !parsed.reply.trim()) return true;
  const reply = parsed.reply.trim();
  return reply.length <= UNGROUNDED_REPLY_MAX && (parsed.handoff || /[?？؟]["')\]」]*$/.test(reply));
}

/**
 * Sent to a public asker when retrieval found nothing and no hosted model's answer passes safeWithoutSources.
 * A prompt alone doesn't stop a model inventing facts without sources, so this check is in code.
 */
const PUBLIC_NO_GROUNDING_DEFLECTION =
  "I don't have anything in our documentation about that yet, so I don't want to guess and risk giving you the wrong answer. I've flagged it for the team — if you'd like, ask to talk to a human and a teammate will help you out.";

/** The ticket-scoped entry point for the /suggest endpoint: find the latest customer
 *  message, then run the shared core. */
export async function suggestReply(tenantId: string, ticketId: string): Promise<Suggestion> {
  const query = await latestCustomerMessage(tenantId, ticketId);
  return suggestForQuery(tenantId, query ?? "", { ticketId });
}
