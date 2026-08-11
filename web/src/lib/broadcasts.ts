import { api, type ApiError } from "@/lib/api";

// Broadcasts — one-to-many campaigns over a chosen channel (email, Discord,
// Telegram, WhatsApp). Compose a subject + body, target a filtered segment of
// contacts (the same condition grammar the contacts directory uses), preview
// the reach per channel, then send — immediately, at a scheduled time, or
// continuously (once to each contact the first time they match the audience).
// Each broadcast keeps its delivery tallies (recipient / sent / failed) as it
// fans out.

/** One targeting condition — the contacts filter grammar. `field` is a core
 *  column (name/email/company/created_at/updated_at/unsubscribed_at),
 *  "attr:<key>", or "event:<name>" (the contact_events timeline — ops limited
 *  to exists / not_exists / after / before); `value` is omitted for the
 *  existence ops. */
export interface SegmentCondition {
  field: string;
  op: string;
  value?: string;
}

/** A contact segment — the contacts filters, reused as campaign targeting.
 *  `conditions` (AND-combined, server caps at 25) is the full builder grammar;
 *  `conditionGroups` (max 10 groups × 25) OR the groups together, each group
 *  AND-combined internally, and the whole block ANDs with `conditions`. The
 *  flat q/company/attr fields stay because the server still honors them and
 *  older broadcasts/saved segments carry them. */
export interface Segment {
  q?: string;
  company?: string;
  attrKey?: string;
  attrValue?: string;
  conditions?: SegmentCondition[];
  conditionGroups?: SegmentCondition[][];
}

export type BroadcastStatus =
  | "draft" // composed, not armed
  | "scheduled" // oneshot armed — a worker fires it at send_at
  | "sending" // oneshot mid-fan-out
  | "active" // continuous — delivers to each contact on their first audience match
  | "sent"
  | "failed"
  | "stopped"; // continuous, permanently ended — a stopped broadcast can't resume

/** How a broadcast delivers: "oneshot" fans out once (immediately, or at
 *  `send_at` when scheduled); "continuous" sends once to each contact the
 *  first time they match the audience, until stopped (or `stop_at`). */
export type BroadcastMode = "oneshot" | "continuous";

/** One block of a block-composed (email) broadcast — mirrors the server's
 *  discriminated union. Merge tags ({{firstName|there}}, {{attr:plan}}, …) are
 *  allowed in text markdown, button label/url, and the subject; the server
 *  substitutes them per recipient at send time. */
export type BroadcastBlock =
  | { type: "text"; md: string }
  | { type: "image"; url: string; alt?: string; width?: number }
  | { type: "button"; label: string; url: string; align?: "left" | "center" }
  | { type: "divider" }
  | { type: "spacer"; height?: number }
  | { type: "html"; html: string };

/** The delivery channel a broadcast fans out over. */
export type BroadcastChannel = "email" | "discord" | "slack" | "telegram" | "whatsapp";

export interface Broadcast {
  id: string;
  subject: string;
  body: string;
  segment: Segment;
  channel: BroadcastChannel;
  /** Audience primitive (0078). "segment" = per-recipient contact-segment send;
   *  "discord_channel" = ONE post to `target_ref` (a Discord channel), optionally
   *  pinging `mention_role_id` and/or rendered as an embed. Discord is always the latter. */
  audience_kind?: "segment" | "discord_channel";
  target_ref?: string | null;
  mention_role_id?: string | null;
  as_embed?: boolean;
  /** Email template id (built-in "branded"/"personal" or a custom uuid) — the
   *  stationery an email broadcast renders in. Absent on pre-template rows. */
  template_id?: string;
  /** Subscription topic (0110) this broadcast belongs to — its footer + List-Unsubscribe opt
   *  out of THIS topic. Null/absent = untopiced (footer opts out globally). */
  topic_id?: string | null;
  /** Block-composed content (email broadcasts) — null/absent when the broadcast
   *  was written as plain markdown `body`. */
  blocks?: BroadcastBlock[] | null;
  status: BroadcastStatus;
  mode: BroadcastMode;
  /** Oneshot: the scheduled fire time (ISO). The server keeps it through a
   *  schedule cancel (back to draft); null when never scheduled or continuous. */
  send_at: string | null;
  /** Continuous: the optional end time (ISO); null runs until stopped. */
  stop_at: string | null;
  recipient_count: number;
  sent_count: number;
  failed_count: number;
  /** Engagement aggregates over all recipients — surfaced on the list (0069 tracking) so the
   *  table can answer "which send worked?" without opening each broadcast. Optional: absent on
   *  rows returned by the pre-list-stats API (graceful until the api ships them). */
  opened?: number;
  clicked?: number;
  /** Provider bounces over all recipients (0109) — lets the list flag a bad send at a glance.
   *  Absent until the delivery-events api ships. */
  bounced?: number;
  /** Conversion goal: a contact_events name counted per recipient within
   *  `goal_days` of delivery. Null when the broadcast has no goal. */
  goal_event: string | null;
  /** The goal's conversion window in days (1–90; server default 7). */
  goal_days: number;
  /** Send window: scheduler-driven sends (a scheduled fire, continuous ticks)
   *  only run on these ISO weekdays (1=Mon…7=Sun). Null = any day. "Send now"
   *  is an explicit human act and bypasses the window entirely. */
  window_days: number[] | null;
  /** Send window bounds as minutes of the day (start inclusive, end exclusive)
   *  in the window's own UTC offset. Both set or both null (= any time). */
  window_start_min: number | null;
  window_end_min: number | null;
  /** The window's UTC offset in minutes (e.g. 120 = UTC+2); null when the
   *  broadcast has no window at all. */
  window_tz_offset_min: number | null;
  created_at: string;
  sent_at: string | null;
}

/** One row of a broadcast's delivery detail. Opens/clicks are email-only
 *  signals (tracking pixel + wrapped links) — chat channels have none, so
 *  their rows keep these null. */
export interface Recipient {
  /** Email address or channel handle, depending on the broadcast's channel. */
  handle: string;
  /** pending | sent | delivered | bounced | complained | failed (0109). */
  status: string;
  error?: string;
  opened_at: string | null;
  clicked_at: string | null;
  /** Provider delivery-event timestamps (0109) — null until a delivery-event webhook is wired. */
  delivered_at?: string | null;
  bounced_at?: string | null;
  bounce_kind?: string | null; // 'hard' | 'soft'
  complained_at?: string | null;
  unsubscribed_at?: string | null; // this recipient opted out after receiving
}

/** Engagement aggregates over ALL of a broadcast's recipients (not just the
 *  capped detail list). `goal` is present only when the broadcast set one.
 *  0109: `sent` = handed to the provider; `delivered`/`bounced`/`complained` are
 *  provider-confirmed (0 until a delivery-event webhook is configured). */
export interface BroadcastStats {
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  unsubscribed: number;
  opened: number;
  clicked: number;
  goal: { event: string; days: number; conversions: number } | null;
}

/** One time bucket of the delivery/engagement timeline — counts of each event that OCCURRED
 *  in that bucket (a recipient sent then opened later lands in two buckets). Powers the
 *  broadcast detail's over-time chart. */
export interface BroadcastTimeseriesBucket {
  t: string; // ISO start of the bucket
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  complained: number;
  unsubscribed: number;
}

export interface BroadcastTimeseries {
  granularity: "hour" | "day";
  buckets: BroadcastTimeseriesBucket[];
  totals: Omit<BroadcastTimeseriesBucket, "t">;
}

/** The delivery/engagement timeline for one broadcast (server auto-selects hour vs day buckets). */
export async function fetchBroadcastTimeseries(id: string): Promise<BroadcastTimeseries> {
  return api<BroadcastTimeseries>(`/broadcasts/${id}/timeseries`);
}

/** One parked address on the suppression list — a hard bounce / spam complaint (auto) or a
 *  manual add. A suppressed address is never re-sent (enforced server-side). */
export interface Suppression {
  address: string;
  reason: string; // hard_bounce | complaint | manual | unsubscribe
  broadcast_id: string | null;
  created_at: string;
}

/** Create payload — the server owns the id, status, and tallies. */
export interface BroadcastInput {
  subject: string;
  body: string;
  /** Block-composed content (email) — when present the server derives the
   *  chat/plaintext form itself and ignores `body`. */
  blocks?: BroadcastBlock[];
  segment: Segment;
  /** Delivery channel — the server defaults to "email" when omitted. */
  channel?: BroadcastChannel;
  /** Audience primitive (0078). Omit (or "segment") for the contact-segment send;
   *  "discord_channel" posts ONCE to `targetRef`. Discord is always upgraded to
   *  channel-post server-side, so a Discord broadcast MUST carry `targetRef`. */
  audienceKind?: "segment" | "discord_channel";
  /** Channel-post: the Discord channel id to post to (required for a Discord broadcast). */
  targetRef?: string | null;
  /** Channel-post: an optional role id to ping (allowedMentions-gated; never @everyone). */
  mentionRoleId?: string | null;
  /** Channel-post: render the post as an embed titled by the subject. */
  asEmbed?: boolean;
  /** Email template (email channel only) — the server defaults to "branded". */
  templateId?: string;
  /** Optional saved-segment source (segments.ts) — recorded as provenance; its filter is snapshotted. */
  segmentId?: string | null;
  /** Subscription topic id (0110) — a live topic, or null for an untopiced (global-footer) send. */
  topicId?: string | null;
  /** Delivery mode — the server defaults to "oneshot". */
  mode?: BroadcastMode;
  /** Oneshot only: fire at this ISO datetime instead of immediately on send.
   *  The server ignores it for continuous drafts and 400s invalid datetimes. */
  sendAt?: string;
  /** Continuous only: stop matching new contacts at this ISO datetime.
   *  Ignored for oneshot drafts. */
  stopAt?: string;
  /** Conversion goal — a contact_events name; omit for no goal. Email links
   *  are click-tracked and UTM-tagged automatically either way. */
  goalEvent?: string;
  /** The goal's conversion window in days (1–90; server default 7). */
  goalDays?: number;
  /** Send window — ISO weekdays (1=Mon…7=Sun) scheduler-driven sends may run
   *  on. Omit for any day. "Send now" bypasses the window either way. */
  windowDays?: number[];
  /** Send window bounds as minutes of the day — the server wants both or
   *  neither, with start < end. */
  windowStartMin?: number;
  windowEndMin?: number;
  /** The window's UTC offset in minutes (server default 0 = UTC). */
  windowTzOffsetMin?: number;
}

/** Draft-edit payload — PATCH /broadcasts/:id takes the create shape with every
 *  field optional (undefined = keep the stored value). The window fields also
 *  accept null, which CLEARS the stored window (undefined would keep it). */
export type BroadcastPatch = Partial<
  Omit<BroadcastInput, "windowDays" | "windowStartMin" | "windowEndMin" | "windowTzOffsetMin">
> & {
  windowDays?: number[] | null;
  windowStartMin?: number | null;
  windowEndMin?: number | null;
  windowTzOffsetMin?: number | null;
};

/** What the reach preview returns: how many contacts match, and how many are
 *  reachable per channel id (a contact needs a handle on that channel). */
export interface SegmentPreview {
  total: number;
  reachable: Record<string, number>;
}

/** One deliverable recipient in the "view recipients" drill-in behind the reach count. */
export interface RecipientPreviewRow {
  name: string | null;
  handle: string;
  company: string | null;
}

/** The recipient drill-in: the capped deliverable set for a channel plus the true totals. */
export interface RecipientsPreview {
  total: number;
  reachable: number;
  recipients: RecipientPreviewRow[];
  /** True when more recipients match than the returned cap — the list is a sample. */
  truncated: boolean;
}

/** True when an error is a 404 — the broadcasts API isn't deployed on this server yet. */
export function isBroadcastsUnavailable(e: unknown): boolean {
  return (e as ApiError | undefined)?.status === 404;
}

/** Strip empty fields so `{}` targets everyone rather than sending noise to the server. */
function cleanSegment(segment: Segment): Segment {
  const out: Segment = {};
  if (segment.q?.trim()) out.q = segment.q.trim();
  if (segment.company?.trim()) out.company = segment.company.trim();
  if (segment.attrKey?.trim()) out.attrKey = segment.attrKey.trim();
  if (segment.attrValue?.trim()) out.attrValue = segment.attrValue.trim();
  // Sliced to the server's caps so an over-built segment degrades instead of 400ing.
  if (segment.conditions?.length) out.conditions = segment.conditions.slice(0, 25);
  const groups = (segment.conditionGroups ?? []).filter((g) => g.length > 0);
  if (groups.length) out.conditionGroups = groups.slice(0, 10).map((g) => g.slice(0, 25));
  return out;
}

export async function fetchBroadcasts(): Promise<Broadcast[]> {
  return (await api<{ broadcasts: Broadcast[] }>("/broadcasts")).broadcasts;
}

export async function fetchBroadcast(
  id: string,
): Promise<{ broadcast: Broadcast; recipients?: Recipient[]; stats?: BroadcastStats }> {
  return api<{ broadcast: Broadcast; recipients?: Recipient[]; stats?: BroadcastStats }>(
    `/broadcasts/${id}`,
  );
}

export async function previewSegment(segment: Segment, topicId?: string | null): Promise<SegmentPreview> {
  return api<SegmentPreview>("/broadcasts/preview", {
    method: "POST",
    body: JSON.stringify({ segment: cleanSegment(segment), topicId: topicId ?? null }),
  });
}

/** List WHO a segment resolves to for a channel — the deliverable set (suppression + topic
 *  applied), capped server-side. Powers the "view recipients" drill-in behind the reach count. */
export async function previewRecipients(
  segment: Segment,
  channel: BroadcastChannel,
  limit = 200,
  topicId?: string | null,
): Promise<RecipientsPreview> {
  return api<RecipientsPreview>("/broadcasts/preview-recipients", {
    method: "POST",
    body: JSON.stringify({ segment: cleanSegment(segment), channel, limit, topicId: topicId ?? null }),
  });
}

export async function createBroadcast(input: BroadcastInput): Promise<Broadcast> {
  const body: Record<string, unknown> = { subject: input.subject, body: input.body, segment: cleanSegment(input.segment) };
  if (input.blocks?.length) body.blocks = input.blocks;
  if (input.channel) body.channel = input.channel;
  if (input.templateId) body.templateId = input.templateId;
  if (input.segmentId) body.segmentId = input.segmentId;
  if (input.topicId !== undefined) body.topicId = input.topicId;
  if (input.mode) body.mode = input.mode;
  if (input.sendAt) body.sendAt = input.sendAt;
  if (input.stopAt) body.stopAt = input.stopAt;
  if (input.goalEvent?.trim()) {
    body.goalEvent = input.goalEvent.trim();
    if (input.goalDays != null) body.goalDays = input.goalDays;
  }
  // Send window — days and/or time bounds; the tz offset only means something
  // once either is present (the server defaults it to 0 = UTC).
  if (input.windowDays?.length) body.windowDays = input.windowDays;
  if (input.windowStartMin != null && input.windowEndMin != null) {
    body.windowStartMin = input.windowStartMin;
    body.windowEndMin = input.windowEndMin;
  }
  if (body.windowDays != null || body.windowStartMin != null) {
    body.windowTzOffsetMin = input.windowTzOffsetMin ?? 0;
  }
  const res = await api<{ broadcast: Broadcast }>("/broadcasts", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return res.broadcast;
}

/** Edits a draft in place — PATCH with the create shape, all fields optional
 *  (undefined keeps the stored value; window fields take null to clear). Only
 *  status "draft" is editable: anything armed/sent 409s with the reason in
 *  `ApiError.detail` — cancel it back to draft first. */
export async function updateBroadcast(id: string, patch: BroadcastPatch): Promise<Broadcast> {
  const body: Record<string, unknown> = { ...patch };
  if (patch.segment) body.segment = cleanSegment(patch.segment);
  // The server validates segmentId as a uuid — a cleared provenance link is
  // simply not sent (it only changes when the operator re-picks a saved segment).
  if (body.segmentId == null) delete body.segmentId;
  const res = await api<{ broadcast: Broadcast }>(`/broadcasts/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  return res.broadcast;
}

/** Arms or fires a broadcast. The returned status says which one happened:
 *  "sending" (immediate mass send), "scheduled" (armed — a worker fires it at
 *  send_at), or "active" (continuous matching started). Sending an
 *  already-scheduled broadcast again fires it immediately. */
export async function sendBroadcast(id: string): Promise<{ status: BroadcastStatus }> {
  return api<{ status: BroadcastStatus }>(`/broadcasts/${id}/send`, { method: "POST" });
}

/** Cancels the automatic side of a broadcast: "scheduled" disarms back to
 *  "draft" (send_at kept), "active" stops permanently ("stopped" — it can't
 *  be resumed). Terminal states 409. */
export async function cancelBroadcast(id: string): Promise<{ status: BroadcastStatus }> {
  return api<{ status: BroadcastStatus }>(`/broadcasts/${id}/cancel`, { method: "POST" });
}

/** Hard-delete a broadcast and its delivery rows. 409s while the send is in flight
 *  ('sending'/'active') — cancel or stop it first, then delete. */
export async function deleteBroadcast(id: string): Promise<void> {
  await api(`/broadcasts/${id}`, { method: "DELETE" });
}

/** A draft's renderable pieces — what preview-render and the test send accept. */
export interface BroadcastRenderInput {
  subject?: string;
  body?: string;
  blocks?: BroadcastBlock[];
  templateId?: string;
}

/** The per-channel chat forms of a draft's derived markdown body (blocks
 *  flatten to markdown first), run through the REAL channel-driver transforms —
 *  `slack` is mrkdwn, `telegram` is Telegram HTML markup, `plain` is the
 *  markup-free text. Sample merge data already substituted. */
export interface BroadcastChatPreview {
  markdown: string;
  discord: string;
  slack: string;
  telegram: string;
  whatsapp: string;
  plain: string;
}

/** Renders a draft through EXACTLY the send-path renderer, with sample merge
 *  data (Ada Lovelace / ada@example.com). `html` is a full document meant for
 *  an `<iframe sandbox srcDoc>`; `chat` carries the per-channel chat forms
 *  (optional so an older server without it degrades quietly). */
export async function previewBroadcastRender(
  input: BroadcastRenderInput,
): Promise<{ html: string; text: string; subject: string; chat?: BroadcastChatPreview }> {
  return api<{ html: string; text: string; subject: string; chat?: BroadcastChatPreview }>(
    "/broadcasts/preview-render",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

/** Sends one rendered test email (subject prefixed "[Test]") to the signed-in
 *  agent's own address. The server 400s without a subject, 502s if the mailer
 *  refuses — surface `ApiError.detail` to the operator. */
export async function sendBroadcastTest(
  input: BroadcastRenderInput & { subject: string },
): Promise<{ delivered: boolean; to: string }> {
  return api<{ delivered: boolean; to: string }>("/broadcasts/test", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// ---- Suppression list -----------------------------------------------------

/** Addresses parked from future sends — auto (hard bounce / spam complaint) or manual. */
export async function fetchSuppressions(): Promise<Suppression[]> {
  return (await api<{ suppressions: Suppression[] }>("/broadcasts/suppressions")).suppressions;
}

export async function addSuppression(address: string): Promise<void> {
  await api("/broadcasts/suppressions", { method: "POST", body: JSON.stringify({ address }) });
}

/** Un-suppress an address (a fixed mailbox, a mistaken complaint). */
export async function removeSuppression(address: string): Promise<void> {
  await api(`/broadcasts/suppressions/${encodeURIComponent(address)}`, { method: "DELETE" });
}

// ---- Subscription topics (multi-level unsubscribe) ------------------------

/** A named list a broadcast can be tagged with; contacts opt out per-topic in the preference center. */
export interface SubscriptionTopic {
  id: string;
  name: string;
  description: string;
  archived: boolean;
  created_at: string;
}

export async function fetchTopics(includeArchived = false): Promise<SubscriptionTopic[]> {
  return (await api<{ topics: SubscriptionTopic[] }>(`/subscription-topics${includeArchived ? "?archived=1" : ""}`)).topics;
}

export async function createTopic(input: { name: string; description?: string }): Promise<SubscriptionTopic> {
  return (await api<{ topic: SubscriptionTopic }>("/subscription-topics", { method: "POST", body: JSON.stringify(input) })).topic;
}

export async function updateTopic(id: string, patch: { name?: string; description?: string; archived?: boolean }): Promise<SubscriptionTopic> {
  return (await api<{ topic: SubscriptionTopic }>(`/subscription-topics/${id}`, { method: "PATCH", body: JSON.stringify(patch) })).topic;
}

export async function deleteTopic(id: string): Promise<void> {
  await api(`/subscription-topics/${id}`, { method: "DELETE" });
}
