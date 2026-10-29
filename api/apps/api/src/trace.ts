import { withTenant } from "@repo/db";
import { hasOutcomeTag, parseDraftOutcome, type DraftOutcome } from "./ai-outcome.js";

// draft_traces: the record of every drafted reply, kept for each workspace's trace retention — the query, the retrieved
// sources + fused scores, the draft, model + tokens + latency, and (back-filled) the
// gate decision and the human outcome. It's both the audit trail and the eval
// baseline — Opik's PATTERN, self-hosted. `TRACE_SINK` optionally mirrors each trace
// to an OTel collector / Opik, fire-and-forget: a down sink NEVER breaks a reply, the
// same discipline as embeddingDriver returning null on failure.

export interface TraceSource {
  kind: string;
  /** The chunk id for a document source, the article or ticket id otherwise. */
  id: string;
  title: string;
  score: number;
  rank: number;
  /** For a document source: its document, and its page when the document came from a URL. */
  documentId?: string;
  url?: string;
  /** Where the keyword and meaning searches ranked the source, from 1, in the search text that scored it higher.
   *  A search that didn't find it leaves its rank out. */
  keywordRank?: number;
  meaningRank?: number;
  /** With a search query, whether the query, the customer's message or both found the source. */
  foundBy?: "query" | "message" | "both";
  /** For a document source: which of the document's passages it is, from 0, and how many it has. */
  passage?: number;
  passages?: number;
  /** The start of the source's text. */
  excerpt?: string;
}

export interface DraftTraceInput {
  tenantId: string;
  ticketId: string | null;
  messageId: string | null;
  query: string;
  /** The query the search model wrote, when retrieval also searched that. */
  searchQuery?: string | null;
  sources: TraceSource[];
  retrieval: { topScore: number; agreement: number };
  draft: string;
  model: string;
  embedModel: string;
  confidence: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number;
  source: "live" | "eval";
}

/** Write one draft_traces row (tenant-scoped, RLS) and fire the optional sink. Returns
 *  the trace id, or null if the write failed — a trace failure must never break the
 *  draft path, so callers treat null as "no trace" and carry on. */
export async function recordDraftTrace(input: DraftTraceInput): Promise<string | null> {
  try {
    const id = await withTenant(input.tenantId, async (c) => {
      const r = await c.query(
        `INSERT INTO draft_traces
           (tenant_id, ticket_id, message_id, query, sources, top_score, agreement,
            draft, model, embed_model, confidence, tokens_in, tokens_out, latency_ms, source, search_query)
         VALUES (current_tenant(), $1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING id`,
        [
          input.ticketId, input.messageId, input.query, JSON.stringify(input.sources),
          input.retrieval.topScore, input.retrieval.agreement, input.draft, input.model,
          input.embedModel, input.confidence, input.tokensIn, input.tokensOut, input.latencyMs, input.source,
          input.searchQuery ?? null,
        ],
      );
      return r.rows[0].id as string;
    });
    void exportSpan(id, input).catch(() => {}); // fire-and-forget; errors already swallowed inside
    return id;
  } catch {
    return null;
  }
}

/** Stamp the gate decision onto a trace after autoreply evaluates it (best-effort). */
export async function updateTraceGate(
  tenantId: string,
  traceId: string,
  gate: { outcome: string; reason: string; riskTags: string[] },
): Promise<void> {
  await withTenant(tenantId, async (c) => {
    await c.query(
      "UPDATE draft_traces SET gate_outcome = $2, gate_reason = $3, risk_tags = $4 WHERE id = $1",
      [traceId, gate.outcome, gate.reason, gate.riskTags],
    );
  }).catch(() => {});
}

const OUTCOMES = new Set(["edited", "sent_as_is", "discarded", "thumbs_up", "thumbs_down"]);

/** Back-fill the human verdict on a trace (edited/sent/discarded/thumbs). */
export async function patchTraceOutcome(tenantId: string, traceId: string, outcome: string): Promise<boolean> {
  if (!OUTCOMES.has(outcome)) {
    throw Object.assign(new Error(`invalid outcome (one of ${[...OUTCOMES].join(", ")})`), { statusCode: 400 });
  }
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      "UPDATE draft_traces SET outcome = $2, outcome_at = now() WHERE id = $1",
      [traceId, outcome],
    );
    return (r.rowCount ?? 0) > 0;
  });
}

// ---- Trace sink seam (TRACE_SINK) — OTel-compatible, off by default ------------
// none (default): DB row only, air-gap-safe. otel-collector: OTLP/HTTP span to
// OTEL_EXPORTER_OTLP_ENDPOINT. opik: the same OTLP path pointed at Opik's ingest
// with its auth/project headers (pattern, not an SDK dependency).

async function exportSpan(traceId: string, input: DraftTraceInput): Promise<void> {
  const sink = process.env.TRACE_SINK ?? "none";
  if (sink === "none") return;
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sink === "opik") {
    if (process.env.OPIK_API_KEY) headers["authorization"] = process.env.OPIK_API_KEY;
    if (process.env.OPIK_WORKSPACE) headers["Comet-Workspace"] = process.env.OPIK_WORKSPACE;
    if (process.env.OPIK_PROJECT) headers["projectName"] = process.env.OPIK_PROJECT;
  }
  try {
    await fetch(`${endpoint.replace(/\/+$/, "")}/v1/traces`, {
      method: "POST",
      headers,
      body: JSON.stringify(buildOtlpSpan(traceId, input)),
    });
  } catch {
    // a down collector must never surface into the reply path
  }
}

function attr(key: string, value: string | number | boolean): { key: string; value: Record<string, unknown> } {
  const v =
    typeof value === "number"
      ? Number.isInteger(value) ? { intValue: value } : { doubleValue: value }
      : typeof value === "boolean"
        ? { boolValue: value }
        : { stringValue: value };
  return { key, value: v };
}

/** Minimal OTLP/HTTP JSON payload: one `copilot.suggest` span carrying gen_ai.* +
 *  noola.* attributes. trace_id = the draft_traces UUID (hex, dashless). */
function buildOtlpSpan(traceId: string, input: DraftTraceInput): unknown {
  const hex = traceId.replace(/-/g, "");
  const endNano = `${Date.now()}000000`;
  const startNano = `${Date.now() - input.latencyMs}000000`;
  const attrs = [
    attr("noola.tenant_id", input.tenantId),
    attr("noola.source", input.source),
    attr("gen_ai.system", input.model),
    attr("gen_ai.request.model", input.model),
    attr("noola.embed_model", input.embedModel),
    attr("noola.retrieval.top_score", input.retrieval.topScore),
    attr("noola.retrieval.agreement", input.retrieval.agreement),
    attr("noola.retrieval.citations", input.sources.length),
  ];
  if (input.ticketId) attrs.push(attr("noola.ticket_id", input.ticketId));
  if (input.messageId) attrs.push(attr("noola.message_id", input.messageId));
  if (input.confidence != null) attrs.push(attr("noola.confidence", input.confidence));
  if (input.tokensIn != null) attrs.push(attr("gen_ai.usage.input_tokens", input.tokensIn));
  if (input.tokensOut != null) attrs.push(attr("gen_ai.usage.output_tokens", input.tokensOut));
  return {
    resourceSpans: [
      {
        resource: { attributes: [attr("service.name", "noola-api")] },
        scopeSpans: [
          {
            scope: { name: "noola.copilot" },
            spans: [
              {
                traceId: hex,
                spanId: hex.slice(0, 16),
                name: "copilot.suggest",
                kind: 1,
                startTimeUnixNano: startNano,
                endTimeUnixNano: endNano,
                attributes: attrs,
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  };
}

// ---- Admin trace viewer --------------------------------------------------------

export interface TraceSummary {
  id: string;
  createdAt: string;
  ticketId: string | null;
  messageId: string | null;
  model: string;
  query: string;
  draftPreview: string;
  gateOutcome: string | null;
  gateReason: string | null;
  /** How many sources the draft was grounded on. Zero means the model answered with nothing to go on. */
  sourceCount: number;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number | null;
}

export interface TraceDetail extends TraceSummary {
  searchQuery: string | null;
  draft: string;
  /** What Noola made of the draft's answer tags. A draft without tags is a plain reply. */
  parsed: DraftOutcome;
  sources: TraceSource[];
  topScore: number | null;
  agreement: number | null;
  confidence: number | null;
  embedModel: string | null;
  riskTags: string[];
  humanOutcome: string | null;
  decisions: { outcome: string; reason: string; source: string; sentMessageId: string | null; createdAt: string }[];
}

const SUMMARY_COLS = `t.id, t.created_at, t.ticket_id, t.message_id, t.model, left(t.query, 200) AS query, left(t.draft, 200) AS draft_preview,
  t.gate_outcome, t.gate_reason, jsonb_array_length(t.sources) AS source_count, t.tokens_in, t.tokens_out, t.latency_ms`;

type SummaryRow = {
  id: string; created_at: Date; ticket_id: string | null; message_id: string | null; model: string; query: string; draft_preview: string;
  gate_outcome: string | null; gate_reason: string | null; source_count: number;
  tokens_in: number | null; tokens_out: number | null; latency_ms: number | null;
};

function toSummary(r: SummaryRow): TraceSummary {
  return {
    id: r.id, createdAt: r.created_at.toISOString(), ticketId: r.ticket_id, messageId: r.message_id, model: r.model, query: r.query,
    draftPreview: r.draft_preview, gateOutcome: r.gate_outcome, gateReason: r.gate_reason, sourceCount: r.source_count,
    tokensIn: r.tokens_in, tokensOut: r.tokens_out, latencyMs: r.latency_ms,
  };
}

/** Every AI draft on a ticket, newest first, including drafts that sent nothing. */
export async function listTicketTraces(tenantId: string, ticketId: string): Promise<TraceSummary[]> {
  const r = await withTenant(tenantId, (c) =>
    c.query<SummaryRow>(`SELECT ${SUMMARY_COLS} FROM draft_traces t WHERE t.ticket_id = $1 ORDER BY t.created_at DESC, t.id DESC LIMIT 200`, [ticketId]),
  );
  return r.rows.map(toSummary);
}

/** What Noola did with a draft, as the workspace trace list filters it. The web's TRACE_CATEGORIES mirror this list. */
export const TRACE_CATEGORIES = ["sent", "held", "note_only", "no_reply", "handoff", "no_sources", "no_decision"] as const;
export type TraceCategory = (typeof TRACE_CATEGORIES)[number];

// The first matching branch wins, so a grounding-guard deflection counts as "no_sources" even when the widget sent it.
const CATEGORY_SQL = `CASE
  WHEN t.model = 'grounding-guard' THEN 'no_sources'
  WHEN t.gate_outcome = 'auto_sent' THEN 'sent'
  WHEN t.gate_reason IN ('no_reply_needed', 'no_reply_suggested') THEN 'no_reply'
  WHEN t.gate_reason = 'note_only' THEN 'note_only'
  WHEN t.gate_reason = 'handoff' THEN 'handoff'
  WHEN t.gate_outcome IS NOT NULL THEN 'held'
  ELSE 'no_decision' END`;

export interface TraceListRow extends TraceSummary {
  ticketSubject: string | null;
}

export interface TraceListQuery {
  page: number;
  pageSize: number;
  outcome: TraceCategory | null;
  /** Matched case-insensitively anywhere in the customer's text. */
  q: string | null;
  from: Date | null;
  /** Exclusive. */
  to: Date | null;
}

const TRACE_PAGE_SIZE_MAX = 100;

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}

/** Reads the list filters from a request's query string. Throws a 400 error on any value it can't use. */
export function parseTraceListQuery(q: Record<string, unknown>): TraceListQuery {
  const int = (key: string, fallback: number, max: number): number => {
    if (q[key] === undefined || q[key] === "") return fallback;
    const n = Number(q[key]);
    if (!Number.isInteger(n) || n < 1 || n > max) throw badRequest(`${key} must be an integer from 1 to ${max}`);
    return n;
  };
  const date = (key: string): Date | null => {
    if (q[key] === undefined || q[key] === "") return null;
    const d = new Date(String(q[key]));
    if (Number.isNaN(d.getTime())) throw badRequest(`${key} must be an ISO date`);
    return d;
  };
  const outcome = q.outcome === undefined || q.outcome === "" ? null : String(q.outcome);
  if (outcome !== null && !(TRACE_CATEGORIES as readonly string[]).includes(outcome)) {
    throw badRequest(`outcome must be one of ${TRACE_CATEGORIES.join(", ")}`);
  }
  const text = typeof q.q === "string" ? q.q.trim() : "";
  if (text.length > 200) throw badRequest("q must be at most 200 characters");
  return {
    page: int("page", 1, 100_000),
    pageSize: int("pageSize", 50, TRACE_PAGE_SIZE_MAX),
    outcome: outcome as TraceCategory | null,
    q: text || null,
    from: date("from"),
    to: date("to"),
  };
}

/** One page of the workspace's traces, newest first, with the ticket subject when the draft belongs to a ticket. */
export async function listTraces(tenantId: string, f: TraceListQuery): Promise<{ traces: TraceListRow[]; total: number }> {
  const conds: string[] = [];
  const params: unknown[] = [];
  const where = (sql: string, value: unknown) => {
    params.push(value);
    conds.push(sql.replace("?", `$${params.length}`));
  };
  // No sources found also matches a draft the model wrote without sources, which the categories file under what it did.
  if (f.outcome === "no_sources") conds.push("(t.model = 'grounding-guard' OR jsonb_array_length(t.sources) = 0)");
  else if (f.outcome) where(`${CATEGORY_SQL} = ?`, f.outcome);
  if (f.q) where("t.query ILIKE ?", `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  if (f.from) where("t.created_at >= ?", f.from);
  if (f.to) where("t.created_at < ?", f.to);
  const filter = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  return withTenant(tenantId, async (c) => {
    const count = await c.query<{ total: number }>(`SELECT count(*)::int AS total FROM draft_traces t ${filter}`, params);
    const rows = await c.query<SummaryRow & { ticket_subject: string | null }>(
      `SELECT ${SUMMARY_COLS}, k.subject AS ticket_subject
         FROM draft_traces t LEFT JOIN tickets k ON k.id = t.ticket_id
         ${filter}
         ORDER BY t.created_at DESC, t.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, f.pageSize, (f.page - 1) * f.pageSize],
    );
    return { traces: rows.rows.map((r) => ({ ...toSummary(r), ticketSubject: r.ticket_subject })), total: count.rows[0].total };
  });
}

/** One trace with its sources, the parsed answer tags and the decisions made on it. Null once retention deleted it. */
export async function getTrace(tenantId: string, traceId: string): Promise<TraceDetail | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query<SummaryRow & {
      draft: string; sources: TraceSource[]; top_score: number | null; agreement: number | null;
      confidence: number | null; embed_model: string | null; risk_tags: string[]; outcome: string | null; full_query: string;
      search_query: string | null;
    }>(
      `SELECT ${SUMMARY_COLS}, t.query AS full_query, t.search_query, t.draft, t.sources, t.top_score, t.agreement, t.confidence, t.embed_model, t.risk_tags, t.outcome
         FROM draft_traces t WHERE t.id = $1`,
      [traceId],
    );
    const t = r.rows[0];
    if (!t) return null;
    const d = await c.query<{ outcome: string; reason: string; source: string; sent_message_id: string | null; created_at: Date }>(
      "SELECT outcome, reason, source, sent_message_id, created_at FROM autoreply_decisions WHERE trace_id = $1 ORDER BY created_at",
      [traceId],
    );
    return {
      ...toSummary(t),
      query: t.full_query,
      searchQuery: t.search_query,
      draft: t.draft,
      parsed: hasOutcomeTag(t.draft) ? parseDraftOutcome(t.draft) : { kind: "ok", reply: t.draft.trim(), note: null, noReply: false, handoff: false },
      sources: t.sources ?? [],
      topScore: t.top_score,
      agreement: t.agreement,
      confidence: t.confidence,
      embedModel: t.embed_model,
      riskTags: t.risk_tags ?? [],
      humanOutcome: t.outcome,
      decisions: d.rows.map((x) => ({
        outcome: x.outcome, reason: x.reason, source: x.source, sentMessageId: x.sent_message_id, createdAt: x.created_at.toISOString(),
      })),
    };
  });
}
