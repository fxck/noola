import { api } from "@/lib/api";
import type { MessageMeta } from "@/lib/tickets";

// Autoreply policy client — a tenant decides whether the AI replies on its own.
// Tenant is server-authoritative from the token. The PUT accepts any subset of
// fields and returns the full policy, so callers send only what changed.

export type AutoreplyMode = "off" | "suggest_only" | "auto";

/** What one channel does with an evaluated inbound message. The global mode is a
 *  ceiling — a channel entry can only restrict, never escalate: auto-send takes global
 *  mode='auto' AND an explicit per-channel 'auto'. 'skip' = don't even draft. */
export type ChannelMode = "auto" | "suggest_only" | "skip";

/** Channels the routing map is edited for (the inbound conversational set). */
export type AutoreplyChannel = "synthetic" | "widget" | "email" | "discord" | "slack" | "telegram" | "whatsapp";

/** Retrieval source kinds, per answering audience ('public' = widget / docs embed /
 *  answer API; 'agent' = copilot + autoreply). Server defaults: public=kb, agent=all. */
export type SourceKind = "kb" | "thread" | "document";

export interface AutoreplyPolicy {
  mode: AutoreplyMode;
  /** 0..3 — distinct source kinds that must corroborate before auto-send. */
  min_agreement: number;
  /** 0..1 — secondary score floor. Not surfaced in the UI; preserved on save. */
  min_top_score: number;
  /** Per-channel routing overrides; unlisted channels degrade to suggest_only under global auto. */
  channel_modes: Partial<Record<string, ChannelMode>>;
  /** Model-confidence floor for auto-send (0..1); null = no floor. */
  min_confidence: number | null;
  /** Per-audience retrieval scoping; {} = server defaults. */
  source_scopes: Partial<Record<"public" | "agent", SourceKind[]>>;
  max_auto_per_thread: number;
  max_auto_per_hour: number;
  kill_switch: boolean;
}

/** PUT body — any subset of the policy fields. */
export type AutoreplyPolicyInput = Partial<AutoreplyPolicy>;

export const DEFAULT_POLICY: AutoreplyPolicy = {
  mode: "off",
  min_agreement: 2,
  min_top_score: 0,
  channel_modes: { synthetic: "auto", discord: "auto" },
  min_confidence: null,
  source_scopes: {},
  max_auto_per_thread: 3,
  max_auto_per_hour: 30,
  kill_switch: false,
};

export const MODE_OPTIONS: {
  value: AutoreplyMode;
  label: string;
  blurb: string;
}[] = [
  {
    value: "off",
    label: "Off",
    blurb: "The AI won't reply on its own. Agents can still use Draft with AI manually.",
  },
  {
    value: "suggest_only",
    label: "Suggest only",
    blurb:
      "Automatically prepares a grounded draft for every incoming message; an agent reviews and sends.",
  },
  {
    value: "auto",
    label: "Auto-send",
    blurb:
      "Sends automatically when the answer is well-supported; otherwise falls back to a draft for a human.",
  },
];

export const CHANNEL_OPTIONS: { value: AutoreplyChannel; label: string }[] = [
  { value: "synthetic", label: "API / synthetic" },
  { value: "widget", label: "Messenger widget" },
  { value: "email", label: "Email" },
  { value: "discord", label: "Discord" },
  { value: "slack", label: "Slack" },
  { value: "telegram", label: "Telegram" },
  { value: "whatsapp", label: "WhatsApp" },
];

export const CHANNEL_MODE_OPTIONS: { value: ChannelMode; label: string; blurb: string }[] = [
  { value: "auto", label: "Auto-send", blurb: "Send when well-supported (needs global Auto-send)" },
  { value: "suggest_only", label: "Suggest", blurb: "Draft for human review" },
  { value: "skip", label: "Skip", blurb: "Don't draft on this channel" },
];

export async function fetchAutoreplyPolicy(): Promise<AutoreplyPolicy> {
  return api<AutoreplyPolicy>("/autoreply/policy");
}

export async function saveAutoreplyPolicy(
  input: AutoreplyPolicyInput,
): Promise<AutoreplyPolicy> {
  return api<AutoreplyPolicy>("/autoreply/policy", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

// ── Per-ticket autoreply decisions ──────────────────────────────────────────
// The trail of what the auto-sender decided for a ticket: whether it replied,
// held for a human, and why. Surfaced in the thread's nerd panel. The server
// shape is intentionally read loosely — fields are optional and we degrade
// gracefully rather than crash when one is missing.

/** What the auto-sender did about an inbound message. */
export type AutoreplyOutcome = "sent" | "held" | "draft" | "skipped" | string;

export interface AutoreplyDecision {
  id?: string;
  ticket_id?: string;
  message_id?: string | null;
  /** The policy mode in effect at decision time. */
  mode?: AutoreplyMode | string;
  /** What actually happened. */
  outcome?: AutoreplyOutcome;
  /** Machine reason code, e.g. "guardrail:refund", "low_agreement". */
  reason?: string | null;
  /** Distinct corroborating source kinds seen. */
  agreement?: number | null;
  /** Agreement threshold the policy required. */
  min_agreement?: number | null;
  /** Top retrieval score at decision time, 0..1. */
  top_score?: number | null;
  created_at?: string;
  [k: string]: unknown;
}

/** Fetch the autoreply decision rows for a ticket. Tolerates either a bare array
 *  or a `{ decisions: [...] }` envelope; returns [] on any unexpected shape. */
export async function fetchAutoreplyDecisions(ticketId: string): Promise<AutoreplyDecision[]> {
  const r = await api<AutoreplyDecision[] | { decisions?: AutoreplyDecision[] }>(
    `/tickets/${ticketId}/autoreply`,
  );
  if (Array.isArray(r)) return r;
  return r?.decisions ?? [];
}

// ── Approval queue ───────────────────────────────────────────────────────────
// Drafts the auto-sender prepared but did NOT send: either the tenant is in
// "suggest only" mode (every inbound gets a draft for a human), or it wanted to
// auto-send but retrieval was too weak to corroborate ("held · low corroboration").
// A human reviews each, then sends as-is, edits then sends, or dismisses.

/** Why a draft is waiting in the queue rather than sent. */
export type QueueReason = "suggest_only" | "weak_retrieval" | string;

export interface QueueItem {
  id: string;
  ticket_id: string;
  ticket_subject: string;
  message_id: string;
  draft_body: string;
  /** The draft's model/retrieval receipt — reuse the AI-answer receipt look. Nullable. */
  meta: MessageMeta | null;
  reason: QueueReason;
  status: string;
  created_at: string;
}

/** Pending drafts awaiting review. Tolerates a bare array or an `{ items: [...] }`
 *  envelope; returns [] on an unexpected shape. Throws on transport/HTTP error so
 *  callers can distinguish "endpoint not wired (404)" from a genuine failure. */
export async function fetchQueue(): Promise<QueueItem[]> {
  const r = await api<QueueItem[] | { items?: QueueItem[] }>("/autoreply/queue");
  if (Array.isArray(r)) return r;
  return r?.items ?? [];
}

/** Send a queued draft — as-is, or with an edited `body`. Returns the sent message. */
export async function sendQueued(id: string, body?: string): Promise<{ message?: unknown }> {
  return api<{ message?: unknown }>(`/autoreply/queue/${encodeURIComponent(id)}/send`, {
    method: "POST",
    body: JSON.stringify(body != null ? { body } : {}),
  });
}

/** Discard a queued draft without sending. */
export async function dismissQueued(id: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/autoreply/queue/${encodeURIComponent(id)}/dismiss`, {
    method: "POST",
    body: "{}",
  });
}

// ── Autopilot jobs ───────────────────────────────────────────────────────────
// The live worker queue for "auto" mode: each ticket that needs a reply becomes a
// job the auto-sender works through — queued → processing → a terminal outcome
// (sent / held / skipped / error). Unlike the approval queue (drafts waiting on a
// human), this is the machine's own backlog draining in real time. The page polls
// while any job is active and refetches on the realtime bus so it reads as alive.

/** A job's lifecycle state. Muted → accent → semantic terminal color in the UI. */
export type JobStatus = "queued" | "processing" | "sent" | "held" | "skipped" | "error";

export interface JobItem {
  id: string;
  ticket_id: string;
  ticket_subject: string;
  status: JobStatus;
  /** Machine reason — the "why" for held/skipped/error rows. Nullable. */
  reason: string | null;
  /** The sent message's id once status is "sent". Nullable. */
  result_message_id: string | null;
  /** The model/retrieval receipt for the reply — reuse the AI-answer receipt look. Nullable. */
  meta: MessageMeta | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/** Per-status tallies for the counts summary. */
export interface JobCounts {
  queued: number;
  processing: number;
  sent: number;
  held: number;
  skipped: number;
  error: number;
}

export interface JobsResponse {
  jobs: JobItem[];
  counts: JobCounts;
}

export const EMPTY_JOB_COUNTS: JobCounts = {
  queued: 0,
  processing: 0,
  sent: 0,
  held: 0,
  skipped: 0,
  error: 0,
};

/** Fetch the autopilot jobs + counts. Read loosely and normalized so a partial or
 *  unexpected shape degrades to an empty board rather than crashing. Throws on
 *  transport/HTTP error (incl. 404) so callers can treat "not wired yet" as empty. */
export async function fetchJobs(): Promise<JobsResponse> {
  const r = await api<Partial<JobsResponse> | null>("/autoreply/jobs");
  return {
    jobs: Array.isArray(r?.jobs) ? (r?.jobs as JobItem[]) : [],
    counts: { ...EMPTY_JOB_COUNTS, ...(r?.counts ?? {}) },
  };
}

/** Sweep the backlog into jobs and kick off processing. Returns how many were queued. */
export async function runAutopilot(): Promise<{ queued: number }> {
  const r = await api<{ queued?: number } | null>("/autoreply/run", {
    method: "POST",
    body: "{}",
  });
  return { queued: r?.queued ?? 0 };
}
