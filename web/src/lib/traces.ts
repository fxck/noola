import { api, type ApiError } from "@/lib/api";

// The admin AI trace viewer: what the model wrote for each draft on a ticket and what Noola did with it.
// Traces hold customer text and raw model output, so the server answers only admins and owners.

export interface TraceSummary {
  id: string;
  createdAt: string;
  /** Null for a public answer that never became a ticket, or an eval run. */
  ticketId: string | null;
  /** The customer message the draft answered. */
  messageId: string | null;
  model: string;
  /** The customer text the draft answered. */
  query: string;
  /** The first 200 characters of the raw model output. */
  draftPreview: string;
  /** Null when nothing recorded a decision, as for Draft with AI or a widget answer without tags. */
  gateOutcome: string | null;
  gateReason: string | null;
  /** How many sources the draft was grounded on. Zero means the model answered with nothing to go on. */
  sourceCount: number;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number | null;
}

/** What Noola made of the draft's answer tags. */
export type ParsedDraft =
  | { kind: "ok"; reply: string; note: string | null; noReply: boolean; handoff: boolean }
  | { kind: "malformed"; problem: string };

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

export interface TraceDecision {
  outcome: string;
  reason: string;
  source: string;
  sentMessageId: string | null;
  createdAt: string;
}

export interface TraceDetail extends TraceSummary {
  /** The query the search model wrote, when retrieval also searched that. */
  searchQuery: string | null;
  /** The full raw model output, answer tags included. */
  draft: string;
  parsed: ParsedDraft;
  sources: TraceSource[];
  topScore: number | null;
  agreement: number | null;
  confidence: number | null;
  embedModel: string | null;
  riskTags: string[];
  humanOutcome: string | null;
  decisions: TraceDecision[];
}

export async function fetchTicketTraces(ticketId: string): Promise<TraceSummary[]> {
  return (await api<{ traces: TraceSummary[] }>(`/tickets/${encodeURIComponent(ticketId)}/traces`)).traces;
}

/** What Noola did with a draft, as the workspace list filters it. Mirrors TRACE_CATEGORIES on the server. */
export type TraceCategory = "sent" | "held" | "note_only" | "no_reply" | "handoff" | "no_sources" | "no_decision";

export const TRACE_CATEGORIES: { value: TraceCategory; label: string }[] = [
  { value: "sent", label: "Sent a reply" },
  { value: "held", label: "Held for review" },
  { value: "note_only", label: "Left a note" },
  { value: "no_reply", label: "No reply needed" },
  { value: "handoff", label: "Handed over" },
  { value: "no_sources", label: "No sources found" },
  { value: "no_decision", label: "No decision recorded" },
];

export function isTraceCategory(v: unknown): v is TraceCategory {
  return TRACE_CATEGORIES.some((c) => c.value === v);
}

export interface TraceListRow extends TraceSummary {
  ticketSubject: string | null;
}

export const TRACE_PAGE_SIZE = 50;

export interface TraceListQuery {
  page: number;
  outcome?: TraceCategory;
  q?: string;
  /** ISO instants. `from` is inclusive, `to` exclusive. */
  from?: string;
  to?: string;
}

export async function fetchTraces(query: TraceListQuery): Promise<{ traces: TraceListRow[]; total: number }> {
  const params = new URLSearchParams({ page: String(query.page), pageSize: String(TRACE_PAGE_SIZE) });
  if (query.outcome) params.set("outcome", query.outcome);
  if (query.q) params.set("q", query.q);
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  return api<{ traces: TraceListRow[]; total: number }>(`/traces?${params}`);
}

export async function fetchTrace(id: string): Promise<TraceDetail> {
  return (await api<{ trace: TraceDetail }>(`/traces/${encodeURIComponent(id)}`)).trace;
}

/** True when the trace is gone, which means retention deleted it. */
export function isTraceGone(e: unknown): boolean {
  return (e as ApiError | undefined)?.status === 404;
}

export type TraceTone = "sent" | "held" | "none";

const REASON_LABELS: Record<string, { label: string; tone: TraceTone }> = {
  sent: { label: "Sent", tone: "sent" },
  ondemand_sent: { label: "Sent", tone: "sent" },
  sent_with_handoff: { label: "Sent, then handed over", tone: "sent" },
  no_reply_needed: { label: "No reply needed", tone: "sent" },
  no_reply_suggested: { label: "Suggests no reply", tone: "held" },
  note_only: { label: "Left a note for the team", tone: "held" },
  handoff: { label: "Handed over to a teammate", tone: "held" },
  handoff_requested: { label: "Customer asked for a person", tone: "held" },
  malformed_output: { label: "Held: malformed answer", tone: "held" },
  suggest_only: { label: "Draft for review", tone: "held" },
  weak_retrieval: { label: "Held: low corroboration", tone: "held" },
  low_confidence: { label: "Held: low confidence", tone: "held" },
  thread_cap: { label: "Held: conversation limit", tone: "held" },
  rate_limited: { label: "Held: hourly limit", tone: "held" },
  ondemand_rate_limited: { label: "Held: hourly limit", tone: "held" },
  ondemand_disabled: { label: "Held: on-demand answers off", tone: "held" },
  claimed_elsewhere: { label: "Answered elsewhere", tone: "none" },
  kill: { label: "Held: AI switched off", tone: "held" },
  channel_skipped: { label: "Skipped on this channel", tone: "none" },
};

/** A short plain-English label for a gate or decision outcome, with the tone to show it in. */
export function traceOutcomeLabel(outcome: string | null, reason: string | null): { label: string; tone: TraceTone } {
  if (!outcome && !reason) return { label: "No decision recorded", tone: "none" };
  if (reason?.startsWith("guardrail")) {
    const tags = reason.split(":")[1];
    return { label: `Held: guardrail${tags ? ` (${tags})` : ""}`, tone: "held" };
  }
  const known = reason ? REASON_LABELS[reason] : undefined;
  if (known) return known;
  return { label: [outcome, reason].filter(Boolean).join(": "), tone: outcome === "auto_sent" ? "sent" : "held" };
}
