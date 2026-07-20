import { api, API_URL, getToken } from "@/lib/api";
import type { TicketSla } from "@/lib/sla";

// ---- Shapes (mirror the api's TicketRow / users / messages) ----------------

export interface Ticket {
  id: string;
  subject: string;
  status: string;
  channel_type: string;
  external_channel_id: string | null;
  whose_turn: "us" | "customer" | null;
  assignee_id: string | null;
  assignee_name: string | null;
  assignee_avatar_url?: string | null;
  priority: TicketPriority;
  tags: string[];
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  first_response_at?: string | null;
  /** Tenant-defined ticket type (taxonomy), or null. */
  type_id?: string | null;
  type_name?: string | null;
  type_color?: string | null;
  /** Per-ticket SLA state (present on table/detail responses; null when SLA disabled). */
  sla?: TicketSla | null;
  /** Message count for the nerd row chip — optional; degrade gracefully if absent. */
  message_count?: number;
  /** When merged into a canonical ticket as a duplicate, that ticket's id (else null/absent). */
  merged_into?: string | null;
  /** When snoozed, the wake time (ISO) — hidden from open queues until then; else null/absent. */
  snoozed_until?: string | null;
  /** Keyword-classified customer sentiment (positive/neutral/negative), or null/absent. */
  sentiment?: string | null;
  /** The contact this conversation belongs to (omnichannel unification), or null. */
  contact_id?: string | null;
  contact_name?: string | null;
  contact_avatar_url?: string | null;
  /** Derived server-side: the contact was seen within the 3-min online window — drives the inbox
   *  presence dot (matches the contacts list/detail). */
  contact_online?: boolean | null;
  /** The contact's company (account) — row/rail context. Optional (older api). */
  company_id?: string | null;
  company_name?: string | null;
  /** The team lane this ticket sits in (Teams, Wave 2), or null. Optional (older api). */
  team_id?: string | null;
  team_name?: string | null;
  /** One-line snippet of the latest message — the list row's scan line. Optional (older api). */
  preview?: string | null;
  /** Operating mode frozen at create: 'staffed' (agents answer) vs 'community' (observed, mods
   *  answer in-channel; no agent queue / SLA — the AI deflects at most once). Optional (older api). */
  support_mode?: "staffed" | "community" | null;
  /** The Discord thread id when this is a thread-ticket (community banner / group-chat view). */
  external_thread_id?: string | null;
  /** Discord guild (server) id for a Discord-origin ticket — with external_thread_id it builds the
   *  deep-link back to the source thread ("View in Discord"). */
  external_guild_id?: string | null;
}

/** Merge this ticket (the duplicate) into `into` (the canonical). Moves messages + closes/flags. */
export async function mergeTicket(id: string, into: string): Promise<{ ok: true; movedMessages: number }> {
  return api(`/tickets/${id}/merge`, { method: "POST", body: JSON.stringify({ into }) });
}

/** Snooze a ticket until `until` (ISO), or unsnooze with null. */
export async function snoozeTicket(id: string, until: string | null): Promise<{ ticket: Ticket }> {
  return api(`/tickets/${id}/snooze`, { method: "POST", body: JSON.stringify({ until }) });
}

/** The set of open-ticket ids the current agent hasn't read (a newer customer message). */
export async function fetchUnreadTicketIds(): Promise<string[]> {
  return (await api<{ ids: string[] }>("/tickets/unread")).ids;
}

/** Mark a ticket read for the current agent (on open). Best-effort. */
export async function markTicketRead(id: string): Promise<void> {
  await api(`/tickets/${id}/read`, { method: "POST" });
}

export type BulkAction = "close" | "reopen" | "assign" | "priority" | "tag" | "team";

/** Apply one action to many tickets. Returns the number updated. */
export async function bulkTickets(
  ids: string[],
  action: BulkAction,
  value?: string | null,
): Promise<number> {
  return (
    await api<{ updated: number }>("/tickets/bulk", {
      method: "POST",
      body: JSON.stringify({ ids, action, value: value ?? null }),
    })
  ).updated;
}

export type TicketPriority = "low" | "normal" | "high" | "urgent";
export const TICKET_PRIORITIES: TicketPriority[] = ["urgent", "high", "normal", "low"];

export interface AgentUser {
  id: string;
  name: string;
  email: string;
  role: string;
  /** API-relative avatar path (render via avatarSrc); null/absent = initials fallback. */
  avatar_url?: string | null;
  /** Routing v2 signals (optional — older api rows omit them). */
  skills?: string[];
  out_of_office?: boolean;
  /** Auto-return time (ISO): after it passes the agent counts as available again
   *  and the flag read-repairs off. Null/absent = away indefinitely. */
  ooo_until?: string | null;
  max_open_tickets?: number | null;
}

/** Partial routing update for one agent (admin-only; 403 otherwise). `reassign: true`
 *  together with `outOfOffice: true` hands the agent's open queue back — team-laned
 *  tickets round-robin to eligible teammates, the rest return to Unassigned. */
export interface UserRoutingPatch {
  skills?: string[];
  outOfOffice?: boolean;
  /** Auto-return time (ISO) for `outOfOffice: true`; null/omitted = indefinite.
   *  Turning out-of-office off clears it server-side. */
  oooUntil?: string | null;
  maxOpenTickets?: number | null;
  reassign?: boolean;
}

export interface UserRoutingResult {
  user: {
    id: string;
    skills: string[];
    out_of_office: boolean;
    ooo_until: string | null;
    max_open_tickets: number | null;
  };
  /** Present when a reassign happened — how many tickets went where. */
  handback?: { reassigned: number; unassigned: number };
}

export async function updateUserRouting(id: string, patch: UserRoutingPatch): Promise<UserRoutingResult> {
  return api(`/users/${id}/routing`, { method: "PATCH", body: JSON.stringify(patch) });
}

/** The instrumentation the api attaches to an AI-authored message — the raw
 *  material for the inline "receipt" under the bubble. Nullable/optional: older
 *  rows and non-AI messages omit it, and the server field may not be live yet. */
/** The auto-translation counterpart stored on a message (Wave 4). `text` is the OTHER-language
 *  rendering of `message.body`; `agentFacing` says which the agent reads by default — "text" for an
 *  inbound foreign message we translated for them, "body" for an outbound reply whose `text` is what
 *  the customer received. */
export interface MessageTranslation {
  text: string;
  from: string;
  to: string;
  agentFacing: "body" | "text";
}

export interface MessageMeta {
  /** Present on AI/autoreply receipts; absent on a translation-only meta. */
  kind?: "autoreply" | "queued_sent";
  model?: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
  latencyMs?: number | null;
  confidence?: number | null;
  sources?: number;
  citedKinds?: string[];
  agreement?: number;
  traceId?: string | null;
  /** Auto-translation, independent of the autoreply fields above. */
  translation?: MessageTranslation | null;
}

/** A file attached to a message (agent reply attachments). Bytes stream through an authed download. */
export interface Attachment {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
}

export interface Message {
  id: string;
  ticket_id: string;
  author_type: string;
  body: string;
  created_at: string;
  /** True when the AI sent this message automatically (autoreply). Optional — older rows omit it. */
  auto?: boolean;
  /** AI-answer instrumentation (model, tokens, cost inputs, sources…). Optional — degrade gracefully. */
  meta?: MessageMeta | null;
  /** Files attached to this message. Absent/[] for messages without attachments. */
  attachments?: Attachment[];
  /** The channel this message arrived/left on (omnichannel unification), or null/absent. */
  channel_type?: string | null;
  /** Read receipt: when the customer last saw this (agent) message — set by the widget foreground
   *  poll or an email tracking-pixel open. Null/absent = not yet seen. Drives the "Seen" line. */
  seen_at?: string | null;
  /** The agent who authored this message (real name, from users) — null/absent for
   *  customer messages, auto-replies, and rows older than the author stamp. */
  author_name?: string | null;
  /** The authoring agent's uploaded avatar (serve path), or null/absent — renders the
   *  photo in the bubble avatar instead of initials. For a Discord thread participant this is
   *  COALESCE'd server-side to the external author's avatar. */
  author_avatar_url?: string | null;
  /** Per-message author classification ('customer'|'agent'|'ai'|'community') — lets a multi-participant
   *  Discord thread label each bubble (e.g. the "Community" chip) instead of one contact identity. */
  author_kind?: string | null;
  /** The raw external (Discord) author name/avatar. author_name/author_avatar_url already COALESCE
   *  these server-side; kept here for explicit rendering when preferred. */
  author_external_name?: string | null;
  author_external_avatar_url?: string | null;
}

export type ViewKey = "all" | "needs_reply" | "approval" | "unassigned" | "my" | "closed";

// ---- Fetchers (tenant is server-authoritative from the session token) ------

export async function fetchOpenTickets(): Promise<Ticket[]> {
  return (await api<{ tickets: Ticket[] }>("/tickets?view=all")).tickets;
}
export async function fetchClosedTickets(): Promise<Ticket[]> {
  return (await api<{ tickets: Ticket[] }>("/tickets?view=closed")).tickets;
}
export async function fetchUsers(): Promise<AgentUser[]> {
  return (await api<{ users: AgentUser[] }>("/users")).users;
}
/** Full-text search over subject + message bodies, tenant-scoped server-side
 *  (Typesense ranks, rows hydrate through RLS). Returns hits in relevance order,
 *  across open AND closed — so it reaches history the loaded views don't hold. */
export async function searchTickets(q: string): Promise<Ticket[]> {
  return (await api<{ tickets: Ticket[] }>(`/search?q=${encodeURIComponent(q)}`)).tickets;
}
/** The channels an agent can send a reply on: `current` is the ticket's channel (the default) and
 *  `channels` is every channel the contact is reachable on (drives the composer's channel picker). */
export interface ReplyChannels {
  current: string;
  channels: string[];
}
export async function fetchMessages(
  ticketId: string,
): Promise<{ messages: Message[]; channels: ReplyChannels; emailCc: string[] }> {
  const r = await api<{ messages: Message[]; channels: ReplyChannels; emailCc?: string[] }>(`/tickets/${ticketId}/messages`);
  return { messages: r.messages, channels: r.channels, emailCc: r.emailCc ?? [] };
}

// ---- Write actions (tenant is server-authoritative; bodies carry only the
//      payload — the api reads the session tenant, never the client's word) ---

/** Reply as the agent. Persists + emits the outbox event + posts to the origin
 *  channel (Discord/email…). `attachmentIds` are pre-uploaded files to attach.
 *  `delivered` reports whether the external post succeeded. */
export async function sendReply(
  ticketId: string,
  body: string,
  attachmentIds?: string[],
  channel?: string,
  cc?: string[],
): Promise<{ delivered: boolean }> {
  return api<{ ticketId: string; messageId: string; delivered: boolean }>(
    `/tickets/${ticketId}/reply`,
    {
      method: "POST",
      body: JSON.stringify({
        body,
        ...(attachmentIds?.length ? { attachmentIds } : {}),
        ...(channel ? { channel } : {}),
        ...(cc?.length ? { cc } : {}),
      }),
    },
  );
}

// ---- Attachments (upload before send; download is authed → blob) -------------

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** Upload a file as a pending attachment for a ticket (claimed onto the reply when it's sent). */
export async function uploadAttachment(ticketId: string, file: File): Promise<Attachment> {
  const fileData = await fileToDataUrl(file);
  return (
    await api<{ attachment: Attachment }>("/uploads/attachment", {
      method: "POST",
      body: JSON.stringify({ ticketId, filename: file.name, file: fileData }),
    })
  ).attachment;
}

/** Fetch an attachment's bytes with the Bearer. The serve route is authed (and forces
 *  content-disposition: attachment), so neither an <a href> nor an <img src> can reach it
 *  directly — callers objectURL the blob (and revoke it when done). */
export async function fetchAttachmentBlob(id: string): Promise<Blob> {
  const t = getToken();
  const res = await fetch(`${API_URL}/attachments/${id}/download`, {
    headers: { ...(t ? { authorization: `Bearer ${t}` } : {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

/** Download an attachment: fetch the bytes with the token, then trigger a browser
 *  download from the blob. */
export async function downloadAttachment(id: string, filename: string): Promise<void> {
  const blob = await fetchAttachmentBlob(id);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Human byte size for an attachment chip. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export interface Citation {
  kind: "kb" | "document" | "thread";
  id: string;
  title: string;
  snippet: string;
}
/** Per-citation retrieval score, for the nerd-mode breakdown. */
export interface PerCitationScore {
  kind: string;
  id: string;
  score: number;
}
/** The retrieval math behind a suggestion — surfaced in nerd mode. */
export interface RetrievalStats {
  topScore: number;
  agreement: number;
  citedKinds: string[];
  perCitation: PerCitationScore[];
}
export interface Suggestion {
  draft: string;
  citations: Citation[];
  model: string;
  basedOn: string | null;
  /** Retrieval breakdown (optional — degrade gracefully if the server omits it). */
  retrieval?: RetrievalStats;
  /** Model self-reported confidence, 0..1. */
  confidence?: number;
  /** Opaque trace id for debugging/observability. */
  traceId?: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
  latencyMs?: number;
}
/** Copilot: a retrieval-augmented suggested reply. The server retrieves the
 *  tenant's KB + document passages relevant to the latest customer message and
 *  drafts a grounded, cited reply. Nothing is sent — the agent reviews first. */
export async function suggestReply(ticketId: string): Promise<Suggestion> {
  // Send an empty JSON object: api() always sets content-type: application/json,
  // and Fastify 400s on that header with no body. The suggestion takes no input.
  return api<Suggestion>(`/tickets/${ticketId}/suggest`, { method: "POST", body: "{}" });
}

/** Assign (assigneeId=null unassigns). The api's composite FK blocks cross-tenant ids. */
export async function assignTicket(ticketId: string, assigneeId: string | null): Promise<void> {
  await api(`/tickets/${ticketId}/assign`, {
    method: "POST",
    body: JSON.stringify({ assigneeId }),
  });
}

// ---- Deep ticketing: the filterable/sortable/paginated ticket table ----------
export interface TicketQuery {
  status?: "open" | "closed" | "all";
  priority?: TicketPriority[];
  tag?: string;
  assigneeId?: string; // "none" = unassigned
  teamId?: string; // "none" = no team lane
  channel?: string;
  q?: string;
  sort?: "updated_at" | "created_at" | "priority" | "sla";
  sortDir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface TicketPage {
  tickets: Ticket[];
  total: number;
  limit: number;
  offset: number;
}

/** Server-side ticket table query (filter/sort/pagination). Returns the page + total count. */
export async function queryTickets(query: TicketQuery): Promise<TicketPage> {
  const p = new URLSearchParams();
  p.set("table", "1");
  if (query.status && query.status !== "all") p.set("status", query.status);
  if (query.priority?.length) p.set("priority", query.priority.join(","));
  if (query.tag) p.set("tag", query.tag);
  if (query.assigneeId) p.set("assigneeId", query.assigneeId);
  if (query.teamId) p.set("teamId", query.teamId);
  if (query.channel) p.set("channel", query.channel);
  if (query.q) p.set("q", query.q);
  if (query.sort) p.set("sort", query.sort);
  if (query.sortDir) p.set("sortDir", query.sortDir);
  p.set("limit", String(query.limit ?? 25));
  p.set("offset", String(query.offset ?? 0));
  return api<TicketPage>(`/tickets?${p.toString()}`);
}

/** A single ticket's full row (routed detail page). */
export async function fetchTicket(id: string): Promise<Ticket> {
  return (await api<{ ticket: Ticket }>(`/tickets/${id}`)).ticket;
}

/** Patch a ticket's priority, tags, and/or type (typeId=null clears the type). */
export async function patchTicket(
  id: string,
  patch: { priority?: TicketPriority; tags?: string[]; typeId?: string | null },
): Promise<Ticket> {
  return (await api<{ ticket: Ticket }>(`/tickets/${id}`, { method: "PATCH", body: JSON.stringify(patch) })).ticket;
}

/** Close / reopen — moves the ticket between the Open and Closed views. */
export async function setTicketOpen(ticketId: string, open: boolean): Promise<void> {
  await api(`/tickets/${ticketId}/${open ? "reopen" : "close"}`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

// ---- View filtering (done client-side over one open + one closed fetch, so
//      switching Views is instant and every count is always live) ------------

export function filterByView(
  view: ViewKey,
  open: Ticket[],
  closed: Ticket[],
  myId: string,
  approvalIds: ReadonlySet<string> = EMPTY_SET,
): Ticket[] {
  switch (view) {
    case "needs_reply":
      return open.filter((t) => t.whose_turn === "us");
    case "approval":
      return open.filter((t) => approvalIds.has(t.id));
    case "unassigned":
      return open.filter((t) => !t.assignee_id);
    case "my":
      return open.filter((t) => t.assignee_id === myId);
    case "closed":
      return closed;
    case "all":
    default:
      return open;
  }
}

const EMPTY_SET: ReadonlySet<string> = new Set();

export function viewCounts(
  open: Ticket[],
  closed: Ticket[],
  myId: string,
  approvalIds: ReadonlySet<string> = EMPTY_SET,
): Record<ViewKey, number> {
  return {
    all: open.length,
    needs_reply: open.filter((t) => t.whose_turn === "us").length,
    approval: open.filter((t) => approvalIds.has(t.id)).length,
    unassigned: open.filter((t) => !t.assignee_id).length,
    my: open.filter((t) => t.assignee_id === myId).length,
    closed: closed.length,
  };
}

// ---- Relative time ("2h ago") ----------------------------------------------

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${Math.max(1, m)}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

export function initials(name: string | null | undefined): string {
  const words = (name || "?").trim().split(/\s+/).filter(Boolean);
  // Multi-word → first letter of the first two words ("Bell Labs" → "BL").
  // Single word → its first two chars ("Beta" → "BE") so distinct names never
  // collapse to the same monogram (the old first-letters-only made "Beta" → "B").
  const chars = words.length >= 2 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2);
  return chars.toUpperCase();
}

/** Deterministic desaturated hue (0–359) from a name — the identity color for its
 *  avatar. Same name → same hue, every time, app-wide. */
export function avatarHue(name: string | null | undefined): number {
  const s = name || "?";
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}
