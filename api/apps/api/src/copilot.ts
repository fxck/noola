import { withTenant } from "@repo/db";
import { modelDriver, embeddingDriver, clip, type DraftResult, type ModelServingDriver } from "./model.js";
import { resolveModelDriver } from "./modelconfig.js";
import { personaFragment } from "./persona.js";
import { searchArticles, hydrateArticles } from "./kb.js";
import { searchDocuments, listDocuments, hydrateChunks } from "./documents.js";
import { searchResolvedThreads, hydrateThreads } from "./threads.js";
import { vectorSearch, type VectorCollection } from "./vector.js";
import { recordDraftTrace } from "./trace.js";
import { isContentGap, recordKnowledgeGap } from "./gaps.js";

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
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
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

/**
 * Hybrid retrieval for one knowledge surface: run the keyword ranker (Typesense)
 * and the vector ranker (Qdrant) in parallel, then RRF-fuse. A null query vector
 * (embedder down) degrades to keyword-only. Returns fused items + fused scores.
 */
async function hybrid<T>(
  keyword: () => Promise<T[]>,
  collection: VectorCollection,
  tenantId: string,
  queryVector: number[] | null,
  hydrate: (ids: string[]) => Promise<T[]>,
  idOf: (t: T) => string,
): Promise<{ items: T[]; scores: Map<string, number> }> {
  const [kw, vec] = await Promise.all([
    keyword(),
    queryVector
      ? vectorSearch(collection, tenantId, queryVector, 20, VEC_FLOOR).then(hydrate).catch(() => [])
      : Promise.resolve<T[]>([]),
  ]);
  return rrfMerge([vec, kw], idOf);
}

export interface Citation {
  kind: "kb" | "document" | "thread";
  id: string;
  title: string;
  snippet: string;
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
 *  keys on this: public answers default to published-KB-only so resolved customer threads
 *  and internal documents can never leak into an anonymous answer. */
export type Audience = "public" | "agent";

const DEFAULT_SCOPES: Record<Audience, string[]> = {
  public: ["kb"],
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
  const draftStarted = Date.now();
  let result: DraftResult;
  let model: string;
  try {
    result = await prep.driver.draftReply(prep.draftInput);
    model = prep.driver.name;
  } catch {
    result = await modelDriver.draftReply(prep.draftInput);
    model = `${modelDriver.name} (fallback)`;
  }
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
      if (text) dr = { text, confidence: 0.7 };
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
    dr = { text, confidence: 0.7 };
  }

  return prep.finalize(dr, model, Date.now() - draftStarted);
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
  draftInput: { customerMessage: string; sources: Array<{ title: string; text: string }>; persona: string };
  citations: Citation[];
  retrieval: RetrievalSummary;
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
  const NONE = { items: [] as never[], scores: new Map<string, number>() };
  const queryVector = (await embeddingDriver.embed([query]))?.[0] ?? null;
  const [artR, thrR, chkR] = await Promise.all([
    scope.has("kb")
      ? hybrid(
          () => retrieve((q) => searchArticles(tenantId, q), query, (a) => `${a.title} ${a.body}`),
          "kb", tenantId, queryVector, (ids) => hydrateArticles(tenantId, ids), (a) => a.id,
        )
      : Promise.resolve(NONE),
    scope.has("thread")
      ? hybrid(
          () => retrieve((q) => searchResolvedThreads(tenantId, q), query, (t) => `${t.subject} ${t.text}`),
          "threads", tenantId, queryVector, (ids) => hydrateThreads(tenantId, ids), (t) => t.ticket_id,
        )
      : Promise.resolve(NONE),
    scope.has("document")
      ? hybrid(
          () => retrieve((q) => searchDocuments(tenantId, q), query, (ch) => ch.text),
          "chunks", tenantId, queryVector, (ids) => hydrateChunks(tenantId, ids), (ch) => ch.id,
        )
      : Promise.resolve(NONE),
  ]);

  const kbTop = artR.items.slice(0, MAX_ARTICLES);
  const threadTop = thrR.items.slice(0, MAX_THREADS);
  const chunkTop = chkR.items.slice(0, MAX_CHUNKS);

  // Resolve chunk → document filename for citation (one list, mapped).
  const docNames = new Map<string, string>();
  if (chunkTop.length > 0) {
    const docs = await listDocuments(tenantId).catch(() => []);
    for (const d of docs) docNames.set(d.id, d.filename);
  }

  const kbSources: Citation[] = kbTop.map((a) => ({
    kind: "kb", id: a.id, title: a.title, snippet: clip(a.body, 180),
  }));
  const threadSources: Citation[] = threadTop.map((t) => ({
    kind: "thread", id: t.ticket_id, title: `Resolved: ${t.subject}`, snippet: clip(t.text, 180),
  }));
  const docSources: Citation[] = chunkTop.map((ch) => ({
    kind: "document", id: ch.document_id, title: docNames.get(ch.document_id) ?? "Document", snippet: clip(ch.text, 180),
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
  const bySource = [
    kbTop.map((a) => ({ title: a.title, text: a.body })),
    threadTop.map((t) => ({ title: `Resolved: ${t.subject}`, text: t.text })),
    chunkTop.map((ch) => ({ title: docNames.get(ch.document_id) ?? "Document", text: ch.text })),
  ];
  const grounding: Array<{ title: string; text: string }> = [];
  for (let i = 0; i < Math.max(0, ...bySource.map((s) => s.length)); i++) {
    for (const src of bySource) if (src[i]) grounding.push(src[i]);
  }

  // Draft through the tenant's configured model (BYO hosted LLM, or the extractive
  // rule baseline). Degrade to the baseline on hosted-model failure rather than 502.
  const driver = await resolveModelDriver(tenantId);
  // The tenant's configured voice (persona.ts) steers the hosted draft; empty/unconfigured is a
  // no-op. Best-effort — a persona lookup failure must never block a draft.
  const persona = await personaFragment(tenantId).catch(() => "");
  const draftInput = { customerMessage: query, sources: grounding, persona };

  // Trace + content-gap + Suggestion assembly, invoked once a DraftResult exists (one-shot
  // or streamed). `latencyMs` is the draft-generation time the caller measured.
  const finalize = async (result: DraftResult, model: string, latencyMs: number): Promise<Suggestion> => {
    const traceSources = perCitation.map((p, i) => ({
      kind: p.kind, id: p.id, title: citations[i]?.title ?? "", score: p.score, rank: i,
    }));
    const traceId = await recordDraftTrace({
      tenantId, ticketId, messageId, query, sources: traceSources, retrieval,
      draft: result.text, model, embedModel: embeddingDriver.name,
      confidence: result.confidence ?? null, tokensIn: result.tokensIn ?? null,
      tokensOut: result.tokensOut ?? null, latencyMs: Date.now() - started, source,
    });
    // Content-gap detection: weak retrieval means the KB couldn't answer this — record it
    // (clustered, best-effort) so it surfaces in the Sources worklist and routes back to authoring.
    if (isContentGap(retrieval.agreement, retrieval.topScore)) {
      void recordKnowledgeGap(tenantId, {
        query, confidence: result.confidence ?? null, topScore: retrieval.topScore,
        agreement: retrieval.agreement, source, ticketId,
      });
    }
    return {
      draft: result.text, citations, model, basedOn: clip(query, 160),
      retrieval, confidence: result.confidence ?? null, traceId,
      tokensIn: result.tokensIn ?? null, tokensOut: result.tokensOut ?? null, latencyMs,
    };
  };

  return { driver, draftInput, citations, retrieval, finalize };
}

/** The ticket-scoped entry point for the /suggest endpoint: find the latest customer
 *  message, then run the shared core. */
export async function suggestReply(tenantId: string, ticketId: string): Promise<Suggestion> {
  const query = await latestCustomerMessage(tenantId, ticketId);
  return suggestForQuery(tenantId, query ?? "", { ticketId });
}
