import type { PoolClient } from "pg";
import { withTenant } from "@repo/db";
import {
  EVENT_TYPES,
  ContactFilterConditions,
  ContactFilterConditionGroups,
  BroadcastBlocks,
  type BroadcastBlock,
} from "@repo/contracts";
import { applyMergeTags, hasMergeTags, type MergeData } from "./merge-tags.js";
import { buildContactWhere, type ListFilters } from "./contacts.js";
import { unsubscribeAvailable, unsubscribeUrl } from "./unsubscribe.js";
import { resolveTemplateTokens, templateExists } from "./email-templates.js";
import { instrumentHtml, trackingAvailable } from "./tracking.js";
import { sendOutboundEmail } from "./email.js";
import { renderBroadcastEmail } from "./emails/broadcast-email.js";
import { getSegment } from "./segments.js";
import {
  CHANNEL_DRIVERS,
  getChannelDriver,
  type DispatchResult,
  type DispatchOptions,
  type OutboundContext,
} from "./channels/registry.js";

// Broadcast — compose a subject+body, target a filtered SEGMENT of the contacts
// directory, pick ONE channel, and mass-send through that channel's driver, logging
// per-recipient delivery. The segment is the exact q/company/attrKey/attrValue filter the
// directory uses (buildContactWhere is the shared choke point). Channel 'email' keeps the
// original outbound-email seam (email.ts → Mailpit in dev) with recipients = contacts that
// carry a usable email; any other registry channel (discord/telegram/whatsapp/…) resolves
// recipients from contact_identities (0062) — each contact's per-channel handle — and
// dispatches via getChannelDriver. Either way recipients are deduped by lowercased handle
// and capped. A send is draft → sending → sent|failed; the actual send is fire-and-forget
// so a big broadcast never blocks the HTTP response, and it emits an outbox
// `noola.broadcast.updated` event on each status change so the edge relays a live UI update.

export interface BroadcastRow {
  id: string;
  subject: string;
  body: string;
  channel: string;
  // Audience primitive (0078). 'segment' (default) = the per-recipient contact-segment path;
  // 'discord_channel' = ONE post to target_ref (a Discord channel), not N DMs. Discord broadcasts
  // are always the latter (the DM path is retired — a user id is not a channel).
  audience_kind: "segment" | "discord_channel";
  target_ref: string | null; // channel-post: the specific channel id to post to
  mention_role_id: string | null; // channel-post: optional role to ping (allowedMentions-gated)
  as_embed: boolean; // channel-post: render the post as an embed
  template_id: string; // email design template: built-in slug or email_templates row id
  blocks: BroadcastBlock[] | null; // block-composer body (0067); null = legacy markdown `body`
  segment: Record<string, unknown>;
  segment_id: string | null;
  mode: "oneshot" | "continuous"; // delivery mode (0068)
  send_at: string | null; // oneshot: fire time; status 'scheduled' until the worker sends
  stop_at: string | null; // continuous: automatic stop
  goal_event: string | null; // conversion goal: a contact_events name (0069)
  goal_days: number; // conversion window after each recipient's send
  // Send window (0072): scheduler-driven sends only run inside it; all-null = anytime.
  window_days: number[] | null; // ISO weekdays 1–7
  window_start_min: number | null;
  window_end_min: number | null;
  window_tz_offset_min: number | null;
  status: "draft" | "scheduled" | "sending" | "active" | "sent" | "failed" | "stopped";
  recipient_count: number;
  sent_count: number;
  failed_count: number;
  // Engagement aggregates surfaced on the LIST (0069 tracking data — previously detail-only).
  // Let the list answer "which send worked?" without opening each broadcast (UX diagnosis t4).
  opened: number;
  clicked: number;
  created_at: string;
  sent_at: string | null;
}

export interface BroadcastRecipientRow {
  id: string;
  broadcast_id: string;
  contact_id: string | null;
  handle: string; // an email address (channel 'email') or a per-channel handle (chat id, phone…)
  status: "pending" | "sent" | "failed";
  error: string | null;
  opened_at: string | null; // first tracked open (email pixel / implied by a click)
  clicked_at: string | null; // first tracked click
  created_at: string;
}

/** The stats block a broadcast detail carries (0069). Opens/clicks are email-only signals
 *  (chat channels have no pixel); goal conversions count recipients whose contact emitted
 *  the goal_event within goal_days of THEIR send. */
export interface BroadcastStats {
  delivered: number;
  opened: number;
  clicked: number;
  goal: { event: string; days: number; conversions: number } | null;
}

const B_COLS =
  "id, subject, body, channel, audience_kind, target_ref, mention_role_id, as_embed, template_id, blocks, segment, segment_id, mode, send_at, stop_at, goal_event, goal_days, window_days, window_start_min, window_end_min, window_tz_offset_min, status, recipient_count, sent_count, failed_count, created_at, sent_at";
const R_COLS = "id, broadcast_id, contact_id, handle, status, error, opened_at, clicked_at, created_at";

// Cap the recipient set a single broadcast resolves (keeps the send bounded) and the
// recipient rows a detail view returns.
const RECIPIENT_CAP = 5000;
const RECIPIENT_VIEW_CAP = 1000;

/**
 * The injectable one-email send seam. Defaults to the real SMTP outbound
 * (email.ts → Mailpit in dev); tests pass a network-free stub. Same delivered/reason
 * shape as the ticket-reply seam.
 */
export type BroadcastSendFn = (
  tenantId: string,
  to: string,
  subject: string,
  body: string,
  opts?: { html?: string; unsubscribeUrl?: string },
) => Promise<{ delivered: boolean; reason?: string }>;

const defaultSend: BroadcastSendFn = (tenantId, to, subject, body, opts) =>
  sendOutboundEmail(tenantId, to, subject, body, opts);

/**
 * The injectable one-message dispatch seam for the non-email channels. Defaults to the
 * registry driver's dispatch; tests pass a network-free stub. Same delivered/reason shape.
 */
export type BroadcastDispatchFn = (ctx: OutboundContext, body: string, opts?: DispatchOptions) => Promise<DispatchResult>;

/** A broadcast can go out over any registry channel that can actually deliver (has a
 *  dispatch fn) — email plus the chat channels. This is the validation + preview set. */
function sendableChannelIds(): string[] {
  return CHANNEL_DRIVERS.filter((d) => typeof d.dispatch === "function").map((d) => d.id);
}

/** Thrown by createBroadcast for a channel that isn't a dispatch-capable registry driver;
 *  the route maps it to a 400. */
export class InvalidChannelError extends Error {
  constructor(channel: string) {
    super(`invalid channel '${channel}' — must be one of: ${sendableChannelIds().join(", ")}`);
    this.name = "InvalidChannelError";
  }
}

/** Thrown by createBroadcast/updateBroadcast for a Discord channel-post broadcast with no
 *  target_ref — a channel-post must name the channel it posts to; the route maps it to a 400. */
export class MissingTargetError extends Error {
  constructor() {
    super("a Discord channel-post broadcast requires targetRef (the channel id to post to)");
    this.name = "MissingTargetError";
  }
}

/** Thrown by createBroadcast for a templateId that is neither a built-in slug nor one of the
 *  tenant's email_templates rows; the route maps it to a 400. */
export class InvalidTemplateError extends Error {
  constructor(templateId: string) {
    super(`invalid templateId '${templateId}' — use 'branded', 'personal', or a saved template id`);
    this.name = "InvalidTemplateError";
  }
}

/** Thrown by createBroadcast for an unparseable sendAt/stopAt; the route maps it to a 400. */
export class InvalidScheduleError extends Error {
  constructor(field: string, value: string) {
    super(`invalid ${field} '${value}' — must be an ISO 8601 datetime`);
    this.name = "InvalidScheduleError";
  }
}

/** Whether `now` falls inside the broadcast's send window. No window fields = always true.
 *  Day + time bounds evaluate in the window's own UTC offset, so "weekdays 9–17" means the
 *  tenant's 9–17, not the server's. Exported for the scheduler (the only enforcement point —
 *  an explicit "Send now" bypasses by design). */
export function inSendWindow(
  b: Pick<BroadcastRow, "window_days" | "window_start_min" | "window_end_min" | "window_tz_offset_min">,
  now: Date = new Date(),
): boolean {
  const hasDays = Array.isArray(b.window_days) && b.window_days.length > 0;
  const hasTime = b.window_start_min != null && b.window_end_min != null;
  if (!hasDays && !hasTime) return true;
  const local = new Date(now.getTime() + (b.window_tz_offset_min ?? 0) * 60_000);
  if (hasDays) {
    const dow = local.getUTCDay() === 0 ? 7 : local.getUTCDay(); // ISO: Mon=1…Sun=7
    if (!b.window_days!.includes(dow)) return false;
  }
  if (hasTime) {
    const mins = local.getUTCHours() * 60 + local.getUTCMinutes();
    if (mins < b.window_start_min! || mins >= b.window_end_min!) return false;
  }
  return true;
}

/** Validate + normalize the window fields off a create/patch input. Throws the 400-mapped
 *  schedule error on a start ≥ end pair (overnight windows aren't supported). */
function parseWindow(input: {
  windowDays?: number[] | null;
  windowStartMin?: number | null;
  windowEndMin?: number | null;
  windowTzOffsetMin?: number | null;
}): { days: number[] | null; start: number | null; end: number | null; tz: number | null } {
  const days = input.windowDays?.length ? [...new Set(input.windowDays)].sort((a, b) => a - b) : null;
  const start = input.windowStartMin ?? null;
  const end = input.windowEndMin ?? null;
  if ((start == null) !== (end == null)) throw new InvalidScheduleError("windowStartMin", "both bounds required");
  if (start != null && end != null && start >= end) throw new InvalidScheduleError("windowEndMin", "must be after start");
  const tz = days || start != null ? (input.windowTzOffsetMin ?? 0) : null;
  return { days, start, end, tz };
}

/** Parse an optional ISO datetime input into a Date, throwing the 400-mapped error. */
function parseWhen(field: string, value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new InvalidScheduleError(field, value);
  return d;
}

/** The stored segment jsonb is the directory filter — the flat string fields plus the
 *  filter-builder `conditions` grammar (the SAME AST the Customers directory compiles;
 *  schema-validated here as the last line before SQL compilation, invalid → ignored). */
function segmentFilters(segment: Record<string, unknown> | null | undefined): ListFilters {
  const s = (segment ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const conds = ContactFilterConditions.safeParse(s.conditions);
  const groups = ContactFilterConditionGroups.safeParse(s.conditionGroups);
  return {
    q: str(s.q),
    company: str(s.company),
    attrKey: str(s.attrKey),
    attrValue: str(s.attrValue),
    conditions: conds.success ? conds.data : undefined,
    conditionGroups: groups.success ? groups.data : undefined,
  };
}

/** Derive the chat/plaintext markdown from a block list — what non-email channels (and the
 *  stored `body` column) carry for a block-composed broadcast. Spacers and raw HTML have no
 *  chat representation; buttons become a bold label + url line. */
export function mdFromBlocks(blocks: BroadcastBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "text") parts.push(b.md.trim());
    else if (b.type === "image") parts.push(b.alt ? `${b.alt}: ${b.url}` : b.url);
    else if (b.type === "button") parts.push(`**${b.label}**: ${b.url}`);
    else if (b.type === "divider") parts.push("---");
  }
  return parts.filter(Boolean).join("\n\n");
}

/** Marketing suppression: broadcast resolution/preview NEVER counts an unsubscribed contact,
 *  on any channel — an opt-out is an opt-out. Composed onto the segment clauses here (the
 *  broadcast-only concern) rather than in buildContactWhere (the directory still lists everyone). */
function suppressedWhere(clauses: string[]): string {
  return clauses.length
    ? `WHERE ${clauses.join(" AND ")} AND unsubscribed_at IS NULL`
    : "WHERE unsubscribed_at IS NULL";
}

/**
 * Preview a segment: how many contacts match, and — per sendable channel — how many
 * distinct deliverable handles it holds (only those can actually receive). Email counts
 * distinct usable contacts.email; every other channel counts the segment's distinct
 * contact_identities handles for that channel_type. Reuses the directory filter; two
 * queries total (one over contacts, one grouped over contact_identities).
 */
export async function previewSegment(
  tenantId: string,
  segment: Record<string, unknown> | null | undefined,
): Promise<{ total: number; reachable: Record<string, number> }> {
  const { clauses, params } = buildContactWhere(segmentFilters(segment));
  const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return withTenant(tenantId, async (c) => {
    // `total` counts the raw segment match; the reachable counts additionally require a
    // deliverable handle AND an active subscription (suppressedWhere), so the composer's
    // per-channel numbers are the true send-time audience.
    const r = await c.query(
      `SELECT count(*)::int AS total,
              count(DISTINCT lower(email)) FILTER (WHERE email IS NOT NULL AND email <> '' AND unsubscribed_at IS NULL)::int AS with_email
         FROM contacts ${whereSql}`,
      params,
    );
    // Filter contacts in a subquery so the segment clauses keep binding bare contacts
    // columns (no alias ambiguity against contact_identities' created_at etc.).
    const byChannel = await c.query(
      `SELECT ci.channel_type, count(DISTINCT lower(ci.external_id))::int AS n
         FROM (SELECT id FROM contacts ${suppressedWhere(clauses)}) mc
         JOIN contact_identities ci ON ci.contact_id = mc.id
        GROUP BY ci.channel_type`,
      params,
    );
    const reachable: Record<string, number> = {};
    for (const id of sendableChannelIds()) reachable[id] = 0;
    for (const row of byChannel.rows as { channel_type: string; n: number }[]) {
      if (row.channel_type !== "email" && row.channel_type in reachable) reachable[row.channel_type] = row.n;
    }
    reachable.email = r.rows[0].with_email as number; // email deliverability = contacts.email, not identity rows
    return { total: r.rows[0].total as number, reachable };
  });
}

/**
 * Resolve a segment to its deliverable recipients for ONE channel, deduped by lowercased
 * handle (newest-touched wins), capped. Email = contacts with a non-empty email; any other
 * channel = the segment's contact_identities handles for that channel_type. Runs inside a
 * caller's tenant-scoped client so it shares the send transaction.
 */
interface ResolvedRecipient {
  id: string;
  handle: string;
  // The merge-tag substitution source — the recipient's own contact fields.
  name: string | null;
  email: string | null;
  company: string | null;
  attributes: Record<string, unknown> | null;
}

async function resolveRecipients(
  c: PoolClient,
  channel: string,
  segment: Record<string, unknown> | null | undefined,
): Promise<ResolvedRecipient[]> {
  const { clauses, params } = buildContactWhere(segmentFilters(segment));
  if (channel === "email") {
    const whereSql = `${suppressedWhere(clauses)} AND email IS NOT NULL AND email <> ''`;
    const r = await c.query(
      `SELECT DISTINCT ON (lower(email)) id, email AS handle, name, email, company, attributes
         FROM contacts ${whereSql}
        ORDER BY lower(email), updated_at DESC
        LIMIT $${params.length + 1}`,
      [...params, RECIPIENT_CAP],
    );
    return r.rows as ResolvedRecipient[];
  }
  // Same subquery shape as previewSegment — segment clauses bind bare contacts columns.
  const r = await c.query(
    `SELECT DISTINCT ON (lower(ci.external_id)) mc.id, ci.external_id AS handle,
            mc.name, mc.email, mc.company, mc.attributes
       FROM (SELECT id, updated_at, name, email, company, attributes
               FROM contacts ${suppressedWhere(clauses)}) mc
       JOIN contact_identities ci ON ci.contact_id = mc.id AND ci.channel_type = $${params.length + 1}
      ORDER BY lower(ci.external_id), mc.updated_at DESC
      LIMIT $${params.length + 2}`,
    [...params, channel, RECIPIENT_CAP],
  );
  return r.rows as ResolvedRecipient[];
}

/** Create a draft broadcast on ONE channel (default 'email'). recipient_count is seeded
 *  from the segment's reachable count for that channel (the actual recipients are resolved
 *  again at send time). Throws InvalidChannelError (→ 400) for a channel that isn't a
 *  dispatch-capable registry driver. */
export async function createBroadcast(
  tenantId: string,
  input: {
    subject: string;
    body?: string;
    channel?: string;
    audienceKind?: "segment" | "discord_channel";
    targetRef?: string | null;
    mentionRoleId?: string | null;
    asEmbed?: boolean;
    segment?: Record<string, unknown>;
    segmentId?: string | null;
    templateId?: string;
    blocks?: BroadcastBlock[];
    mode?: "oneshot" | "continuous";
    sendAt?: string;
    stopAt?: string;
    goalEvent?: string;
    goalDays?: number;
    windowDays?: number[] | null;
    windowStartMin?: number | null;
    windowEndMin?: number | null;
    windowTzOffsetMin?: number | null;
  },
): Promise<BroadcastRow> {
  let channel = input.channel ?? "email";
  if (typeof getChannelDriver(channel)?.dispatch !== "function") throw new InvalidChannelError(channel);
  // Discord broadcasts are channel-posts, never per-recipient DMs (Decision 5 — the DM path fired a
  // user id as a channel and never delivered). Any Discord audience is upgraded to channel-post, and
  // a channel-post must name its target channel.
  let audienceKind = input.audienceKind ?? "segment";
  if (channel === "discord") audienceKind = "discord_channel";
  if (audienceKind === "discord_channel") {
    channel = "discord";
    if (!input.targetRef?.trim()) throw new MissingTargetError();
  }
  const targetRef = audienceKind === "discord_channel" ? input.targetRef!.trim() : null;
  const mentionRoleId = audienceKind === "discord_channel" ? (input.mentionRoleId?.trim() || null) : null;
  const asEmbed = audienceKind === "discord_channel" ? Boolean(input.asEmbed) : false;
  const templateId = input.templateId ?? "branded";
  if (!(await templateExists(tenantId, templateId))) throw new InvalidTemplateError(templateId);
  // A channel-post is a single post — 'continuous' (drip to first-time segment matchers) is
  // meaningless for it, so it's pinned to oneshot.
  const mode = audienceKind === "discord_channel" ? "oneshot" : (input.mode ?? "oneshot");
  // sendAt belongs to oneshot (a continuous broadcast starts when you start it); stopAt to
  // continuous. Cross-mode values are dropped rather than rejected — a mode flip in the
  // composer shouldn't strand a stale hidden field into a 400.
  const sendAt = mode === "oneshot" ? parseWhen("sendAt", input.sendAt) : null;
  const stopAt = mode === "continuous" ? parseWhen("stopAt", input.stopAt) : null;
  // Block-composed broadcasts own their body: `body` becomes the chat/plaintext derivation
  // (list previews and non-email channels read it), the blocks are the email source of truth.
  const blocks = input.blocks?.length ? input.blocks : null;
  const body = blocks ? mdFromBlocks(blocks) : (input.body ?? null);
  // A saved segment (segments.ts) can supply the audience: snapshot its flat filter fields into the
  // broadcast so recipients resolve exactly like a hand-built segment, and record segment_id as
  // provenance. An explicit inline segment on the request still wins field-by-field.
  let segment = input.segment ?? {};
  let segmentId: string | null = input.segmentId ?? null;
  if (segmentId) {
    const saved = await getSegment(tenantId, segmentId);
    if (!saved) segmentId = null;
    else {
      const def = saved.definition ?? {};
      const pick = (k: string) => (typeof def[k] === "string" ? (def[k] as string) : undefined);
      // Saved Customers views store the condition list under `filters`; the broadcast segment
      // key is `conditions` — normalize on snapshot so resolution reads one shape.
      const conds = Array.isArray(def.conditions) ? def.conditions : Array.isArray(def.filters) ? def.filters : undefined;
      segment = {
        q: pick("q"),
        company: pick("company"),
        attrKey: pick("attrKey"),
        attrValue: pick("attrValue"),
        ...(conds ? { conditions: conds } : {}),
        ...segment,
      };
    }
  }
  const win = parseWindow(input);
  // A channel-post is one post → estimate 1; a segment estimate needs the reachable-handle count.
  const recipientCount = audienceKind === "discord_channel" ? 1 : ((await previewSegment(tenantId, segment)).reachable[channel] ?? 0);
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO broadcasts (tenant_id, subject, body, channel, audience_kind, target_ref, mention_role_id, as_embed, template_id, blocks, segment, segment_id, mode, send_at, stop_at, goal_event, goal_days, window_days, window_start_min, window_end_min, window_tz_offset_min, recipient_count)
       VALUES (current_tenant(), $1, COALESCE($2,''), $3, $4, $5, $6, $7, $8, $9::jsonb, COALESCE($10,'{}'::jsonb), $11, $12, $13, $14, $15, $16, $17::int[], $18, $19, $20, $21)
       RETURNING ${B_COLS}`,
      [
        input.subject,
        body,
        channel,
        audienceKind,
        targetRef,
        mentionRoleId,
        asEmbed,
        templateId,
        blocks ? JSON.stringify(blocks) : null,
        JSON.stringify(segment),
        segmentId,
        mode,
        sendAt,
        stopAt,
        input.goalEvent?.trim() || null,
        Math.min(Math.max(Math.trunc(input.goalDays ?? 7), 1), 90),
        win.days,
        win.start,
        win.end,
        win.tz,
        recipientCount,
      ],
    );
    return r.rows[0] as BroadcastRow;
  });
}

/** Draft-only edit (0072): same surface as create, but the row must still be status 'draft' —
 *  anything already armed/sent is immutable (cancel back to draft first). Undefined fields
 *  keep their stored values; the recipient estimate re-resolves when the audience changed.
 *  Returns null when the id is absent, throws NotDraftError when it isn't editable. */
export class NotDraftError extends Error {
  constructor(status: string) { super(`broadcast is ${status}, only drafts can be edited`); }
}

export async function updateBroadcast(
  tenantId: string,
  id: string,
  input: Partial<Parameters<typeof createBroadcast>[1]>,
): Promise<BroadcastRow | null> {
  const existing = await withTenant(tenantId, async (c) => {
    const r = await c.query(`SELECT ${B_COLS} FROM broadcasts WHERE id = $1`, [id]);
    return r.rowCount ? (r.rows[0] as BroadcastRow) : null;
  });
  if (!existing) return null;
  if (existing.status !== "draft") throw new NotDraftError(existing.status);

  let channel = input.channel ?? existing.channel;
  if (typeof getChannelDriver(channel)?.dispatch !== "function") throw new InvalidChannelError(channel);
  let audienceKind = input.audienceKind ?? existing.audience_kind;
  if (channel === "discord") audienceKind = "discord_channel";
  const targetRef =
    audienceKind === "discord_channel"
      ? (input.targetRef !== undefined ? (input.targetRef?.trim() || null) : existing.target_ref)
      : null;
  if (audienceKind === "discord_channel") {
    channel = "discord";
    if (!targetRef) throw new MissingTargetError();
  }
  const mentionRoleId =
    audienceKind === "discord_channel"
      ? (input.mentionRoleId !== undefined ? (input.mentionRoleId?.trim() || null) : existing.mention_role_id)
      : null;
  const asEmbed =
    audienceKind === "discord_channel"
      ? (input.asEmbed !== undefined ? Boolean(input.asEmbed) : existing.as_embed)
      : false;
  const templateId = input.templateId ?? existing.template_id;
  if (!(await templateExists(tenantId, templateId))) throw new InvalidTemplateError(templateId);
  const mode = audienceKind === "discord_channel" ? "oneshot" : (input.mode ?? existing.mode);
  const sendAt = mode === "oneshot"
    ? (input.sendAt !== undefined ? parseWhen("sendAt", input.sendAt) : existing.send_at ? new Date(existing.send_at) : null)
    : null;
  const stopAt = mode === "continuous"
    ? (input.stopAt !== undefined ? parseWhen("stopAt", input.stopAt) : existing.stop_at ? new Date(existing.stop_at) : null)
    : null;
  const blocks = input.blocks !== undefined ? (input.blocks?.length ? input.blocks : null) : existing.blocks;
  const body = input.blocks !== undefined || input.body !== undefined
    ? (blocks ? mdFromBlocks(blocks) : (input.body ?? existing.body))
    : existing.body;
  const segment = input.segment !== undefined ? (input.segment ?? {}) : existing.segment;
  const win = input.windowDays !== undefined || input.windowStartMin !== undefined || input.windowEndMin !== undefined || input.windowTzOffsetMin !== undefined
    ? parseWindow(input)
    : { days: existing.window_days, start: existing.window_start_min, end: existing.window_end_min, tz: existing.window_tz_offset_min };
  const recipientCount = audienceKind === "discord_channel" ? 1 : ((await previewSegment(tenantId, segment)).reachable[channel] ?? 0);

  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `UPDATE broadcasts SET
         subject = $2, body = COALESCE($3,''), channel = $4, audience_kind = $18, target_ref = $19,
         mention_role_id = $20, as_embed = $21, template_id = $5, blocks = $6::jsonb,
         segment = $7::jsonb, mode = $8, send_at = $9, stop_at = $10, goal_event = $11, goal_days = $12,
         window_days = $13::int[], window_start_min = $14, window_end_min = $15, window_tz_offset_min = $16,
         recipient_count = $17
       WHERE id = $1 AND status = 'draft'
       RETURNING ${B_COLS}`,
      [
        id,
        input.subject ?? existing.subject,
        body,
        channel,
        templateId,
        blocks ? JSON.stringify(blocks) : null,
        JSON.stringify(segment),
        mode,
        sendAt,
        stopAt,
        input.goalEvent !== undefined ? (input.goalEvent?.trim() || null) : existing.goal_event,
        input.goalDays !== undefined ? Math.min(Math.max(Math.trunc(input.goalDays ?? 7), 1), 90) : existing.goal_days,
        win.days,
        win.start,
        win.end,
        win.tz,
        recipientCount,
        audienceKind,
        targetRef,
        mentionRoleId,
        asEmbed,
      ],
    );
    return r.rowCount ? (r.rows[0] as BroadcastRow) : null;
  });
}

export async function listBroadcasts(tenantId: string): Promise<BroadcastRow[]> {
  return withTenant(tenantId, async (c) => {
    // Engagement aggregates per broadcast via a LATERAL over recipients (RLS-scoped underneath),
    // so the list surfaces opened/clicked without a per-row round-trip.
    const r = await c.query(
      `SELECT ${B_COLS}, s.opened, s.clicked
         FROM broadcasts
         LEFT JOIN LATERAL (
           SELECT count(opened_at)::int AS opened, count(clicked_at)::int AS clicked
             FROM broadcast_recipients r WHERE r.broadcast_id = broadcasts.id
         ) s ON true
        ORDER BY created_at DESC`,
    );
    return r.rows as BroadcastRow[];
  });
}

/** A broadcast with a capped snapshot of its recipient rows (the delivery log) and the
 *  aggregate engagement stats (0069) — aggregates run over ALL recipients, not the cap. */
export async function getBroadcast(
  tenantId: string,
  id: string,
): Promise<{ broadcast: BroadcastRow; recipients: BroadcastRecipientRow[]; stats: BroadcastStats } | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(`SELECT ${B_COLS} FROM broadcasts WHERE id = $1`, [id]);
    if (!r.rowCount) return null;
    const broadcast = r.rows[0] as BroadcastRow;
    const recips = await c.query(
      `SELECT ${R_COLS} FROM broadcast_recipients WHERE broadcast_id = $1 ORDER BY created_at ASC LIMIT $2`,
      [id, RECIPIENT_VIEW_CAP],
    );
    const agg = await c.query(
      `SELECT count(*) FILTER (WHERE status = 'sent')::int AS delivered,
              count(opened_at)::int AS opened,
              count(clicked_at)::int AS clicked
         FROM broadcast_recipients WHERE broadcast_id = $1`,
      [id],
    );
    let goal: BroadcastStats["goal"] = null;
    if (broadcast.goal_event) {
      const conv = await c.query(
        `SELECT count(DISTINCT r.contact_id)::int AS n
           FROM broadcast_recipients r
           JOIN contact_events ce
             ON ce.contact_id = r.contact_id
            AND ce.name = $2
            AND ce.created_at >= r.created_at
            AND ce.created_at <= r.created_at + make_interval(days => $3)
          WHERE r.broadcast_id = $1 AND r.status = 'sent'`,
        [id, broadcast.goal_event, broadcast.goal_days],
      );
      goal = { event: broadcast.goal_event, days: broadcast.goal_days, conversions: conv.rows[0].n as number };
    }
    return {
      broadcast,
      recipients: recips.rows as BroadcastRecipientRow[],
      stats: { ...(agg.rows[0] as { delivered: number; opened: number; clicked: number }), goal },
    };
  });
}

export async function listRecipients(
  tenantId: string,
  broadcastId: string,
  cap = RECIPIENT_VIEW_CAP,
): Promise<BroadcastRecipientRow[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT ${R_COLS} FROM broadcast_recipients WHERE broadcast_id = $1 ORDER BY created_at ASC LIMIT $2`,
      [broadcastId, cap],
    );
    return r.rows as BroadcastRecipientRow[];
  });
}

/** Emit the outbox event so the edge relays a live UI update on each status change.
 *  Same transactional-outbox pattern as ingest/sources, on the per-tenant subject. */
async function emitBroadcastUpdated(tenantId: string, broadcastId: string, status: string): Promise<void> {
  await withTenant(tenantId, async (c) => {
    const envelope = {
      id: broadcastId,
      type: EVENT_TYPES.broadcastUpdated,
      tenantId,
      occurredAt: new Date().toISOString(),
      data: { broadcastId, status },
    };
    await c.query(
      "INSERT INTO outbox (tenant_id, event_type, subject, payload) VALUES (current_tenant(), $1, 'noola.events.' || current_tenant(), $2::jsonb)",
      [EVENT_TYPES.broadcastUpdated, JSON.stringify(envelope)],
    );
  });
}

/**
 * Send (or arm) a broadcast. From 'draft' the DELIVERY SETTINGS decide the transition:
 * continuous mode → 'active' (the scheduler ticks it); a future send_at → 'scheduled' (the
 * scheduler fires it when due); otherwise the immediate path — 'sending', resolve the
 * segment → deliverable recipients, insert a pending row per recipient, kick the actual
 * per-recipient send in the background, return immediately. Calling send on a 'scheduled'
 * broadcast fires it NOW (the "don't wait" affordance). The returned `done` promise
 * resolves when the background send finishes (the route ignores it; tests await it).
 *
 * Returns null if the broadcast doesn't exist; { status } (unchanged) for any other state.
 */
export async function sendBroadcast(
  tenantId: string,
  id: string,
  opts: { send?: BroadcastSendFn; dispatch?: BroadcastDispatchFn; now?: Date } = {},
): Promise<{ status: string; done?: Promise<void> } | null> {
  const send = opts.send ?? defaultSend;
  const now = opts.now ?? new Date();

  const prep = await withTenant(tenantId, async (c) => {
    const cur = await c.query(
      "SELECT status, mode, send_at, subject, body, channel, audience_kind, target_ref, mention_role_id, as_embed, template_id, blocks, segment FROM broadcasts WHERE id = $1",
      [id],
    );
    if (!cur.rowCount) return { kind: "not-found" as const };
    const status = cur.rows[0].status as string;
    if (status !== "draft" && status !== "scheduled") return { kind: "not-draft" as const, status };
    // Channel-post (0078): ONE post to a channel, not a per-recipient loop. No segment resolution,
    // no merge tags, no tracking, no scheduling arm — send it now. It's pinned to oneshot at create.
    if (cur.rows[0].audience_kind === "discord_channel") {
      const targetRef = cur.rows[0].target_ref as string | null;
      if (!targetRef) {
        await c.query("UPDATE broadcasts SET status = 'failed' WHERE id = $1", [id]);
        return { kind: "misconfigured" as const };
      }
      await c.query("UPDATE broadcasts SET status = 'sending', recipient_count = 1 WHERE id = $1", [id]);
      // One delivery-log row: null contact_id, handle = the channel id posted to.
      const ins = await c.query(
        `INSERT INTO broadcast_recipients (tenant_id, broadcast_id, contact_id, handle, status)
         VALUES (current_tenant(), $1, NULL, $2, 'pending') RETURNING id`,
        [id, targetRef],
      );
      return {
        kind: "channel-post" as const,
        subject: cur.rows[0].subject as string,
        body: (cur.rows[0].body as string) ?? "",
        channel: cur.rows[0].channel as string,
        targetRef,
        mentionRoleId: cur.rows[0].mention_role_id as string | null,
        asEmbed: cur.rows[0].as_embed as boolean,
        recipientRowId: ins.rows[0].id as string,
      };
    }
    if (cur.rows[0].mode === "continuous") {
      // The draft's recipient_count was the create-time audience ESTIMATE; from here on the
      // ticks accumulate it as "people reached so far" — reset so the two don't double-count.
      await c.query("UPDATE broadcasts SET status = 'active', recipient_count = 0 WHERE id = $1", [id]);
      return { kind: "armed" as const, status: "active" };
    }
    const sendAt = cur.rows[0].send_at ? new Date(cur.rows[0].send_at as string) : null;
    if (status === "draft" && sendAt && sendAt.getTime() > now.getTime()) {
      await c.query("UPDATE broadcasts SET status = 'scheduled' WHERE id = $1", [id]);
      return { kind: "armed" as const, status: "scheduled" };
    }
    const subject = cur.rows[0].subject as string;
    const body = (cur.rows[0].body as string) ?? "";
    const channel = cur.rows[0].channel as string;
    const templateId = cur.rows[0].template_id as string;
    // Stored blocks re-validate on the way out (last line before render) — invalid → legacy body path.
    const parsedBlocks = BroadcastBlocks.safeParse(cur.rows[0].blocks);
    const blocks = parsedBlocks.success ? parsedBlocks.data : null;
    const segment = cur.rows[0].segment as Record<string, unknown>;
    const recipients = await resolveRecipients(c, channel, segment);
    await c.query("UPDATE broadcasts SET status = 'sending', recipient_count = $2 WHERE id = $1", [
      id,
      recipients.length,
    ]);
    const inserted: SendRecipient[] = [];
    for (const rc of recipients) {
      // Email logs the lowercased address (the dedupe key); other channels log the handle
      // verbatim — chat/channel ids can be case-significant (e.g. Slack's C0123ABC).
      const ins = await c.query(
        `INSERT INTO broadcast_recipients (tenant_id, broadcast_id, contact_id, handle, status)
         VALUES (current_tenant(), $1, $2, $3, 'pending') RETURNING id`,
        [id, rc.id, channel === "email" ? rc.handle.toLowerCase() : rc.handle],
      );
      inserted.push({
        id: ins.rows[0].id as string,
        handle: rc.handle,
        contactId: rc.id,
        merge: { name: rc.name, email: rc.email, company: rc.company, attributes: rc.attributes },
      });
    }
    return { kind: "ready" as const, subject, body, channel, templateId, blocks, recipients: inserted };
  });

  if (prep.kind === "not-found") return null;
  if (prep.kind === "not-draft") return { status: prep.status };
  if (prep.kind === "misconfigured") {
    await emitBroadcastUpdated(tenantId, id, "failed");
    return { status: "failed" };
  }
  if (prep.kind === "armed") {
    await emitBroadcastUpdated(tenantId, id, prep.status);
    return { status: prep.status };
  }
  if (prep.kind === "channel-post") {
    await emitBroadcastUpdated(tenantId, id, "sending");
    const done = runChannelPost(tenantId, id, prep, opts.dispatch).catch(() => {});
    return { status: "sending", done };
  }

  await emitBroadcastUpdated(tenantId, id, "sending");

  const done = runSend(
    tenantId,
    id,
    prep.channel,
    prep.templateId,
    prep.subject,
    prep.body,
    prep.blocks,
    prep.recipients,
    send,
    opts.dispatch,
  ).catch(() => {});
  return { status: "sending", done };
}

/** One resolved send target: the recipient row id, wire handle, and merge-tag source. */
interface SendRecipient {
  id: string;
  handle: string;
  contactId: string;
  merge: MergeData;
}

/** The background per-recipient send loop: send each (channel 'email' via the email seam,
 *  everything else via the channel driver's dispatch), record sent/failed(+error), tick the
 *  parent counters as it goes, then finalize status = 'sent' (any delivered / nothing to do)
 *  or 'failed' (recipients existed but all failed). Emits a final status event. */
async function runSend(
  tenantId: string,
  broadcastId: string,
  channel: string,
  templateId: string,
  subject: string,
  body: string,
  blocks: BroadcastBlock[] | null,
  recipients: SendRecipient[],
  send: BroadcastSendFn,
  dispatchOverride?: BroadcastDispatchFn,
  // Continuous ticks send incrementally: counters accumulate but the broadcast must stay
  // 'active' (no terminal status, no sent_at stamp).
  keepActive = false,
): Promise<void> {
  // Email: render the template-styled HTML + plaintext ONCE (subject/body/blocks/tokens are
  // constant across recipients) via React Email. If rendering fails (e.g. air-gapped), fall
  // back to the raw markdown as the plaintext body and no HTML — the send still goes out.
  // The per-recipient parts substitute into the rendered output (cheaper than a re-render
  // per contact): the signed unsubscribe link (placeholder) and merge tags, which survive
  // the render as literal {{...}} text.
  const isEmail = channel === "email";
  const UNSUB_PLACEHOLDER = "%%UNSUBSCRIBE_URL%%";
  const withUnsub = isEmail && unsubscribeAvailable();
  const rendered = isEmail
    ? await resolveTemplateTokens(tenantId, templateId)
        .then((tokens) =>
          renderBroadcastEmail(subject, body, {
            tokens,
            ...(blocks ? { blocks } : {}),
            ...(withUnsub ? { unsubscribeHref: UNSUB_PLACEHOLDER } : {}),
          }),
        )
        .catch(() => null)
    : null;
  const personalize =
    hasMergeTags(subject) || (rendered ? hasMergeTags(rendered.html) : hasMergeTags(body));

  // Chat channels have no subject line — fold it into the body as a bold lead instead.
  const chatBody = subject ? `**${subject}**\n\n${body}` : body;
  const dispatch: BroadcastDispatchFn =
    dispatchOverride ??
    ((ctx, b) => {
      const driver = getChannelDriver(channel);
      if (!driver?.dispatch) return Promise.resolve({ delivered: false, reason: `no dispatch for channel '${channel}'` });
      return driver.dispatch(ctx, b);
    });

  for (const rc of recipients) {
    let ok = false;
    let errMsg: string | null = null;
    try {
      const unsub = withUnsub ? unsubscribeUrl(tenantId, rc.contactId) : null;
      let sendText = rendered
        ? unsub
          ? rendered.text.split(UNSUB_PLACEHOLDER).join(unsub)
          : rendered.text
        : unsub
          ? `${body}\n\nUnsubscribe: ${unsub}`
          : body;
      let sendHtml = rendered ? (unsub ? rendered.html.split(UNSUB_PLACEHOLDER).join(unsub) : rendered.html) : undefined;
      let sendSubject = subject;
      if (personalize) {
        sendSubject = applyMergeTags(subject, rc.merge);
        sendText = applyMergeTags(sendText, rc.merge);
        if (sendHtml) sendHtml = applyMergeTags(sendHtml, rc.merge, { html: true });
      }
      // Engagement tracking (0069): wrap links (with UTM) + open pixel, AFTER merge
      // substitution so personalized URLs are tracked too. Email HTML only — plaintext
      // stays clean and chat channels have no pixel semantics.
      if (sendHtml && trackingAvailable()) {
        sendHtml = instrumentHtml(sendHtml, tenantId, rc.id, `b-${broadcastId.slice(0, 8)}`);
      }
      const res = isEmail
        ? await send(tenantId, rc.handle, sendSubject, sendText, {
            ...(sendHtml ? { html: sendHtml } : {}),
            ...(unsub ? { unsubscribeUrl: unsub } : {}),
          })
        : await dispatch(
            { tenantId, channelType: channel, externalChannelId: rc.handle, subject: sendSubject },
            personalize ? applyMergeTags(chatBody, rc.merge) : chatBody,
          );
      ok = res.delivered;
      if (!ok) errMsg = res.reason ?? "not-delivered";
    } catch (e) {
      ok = false;
      errMsg = (e as Error)?.message ?? "send-error";
    }
    await withTenant(tenantId, async (c) => {
      await c.query("UPDATE broadcast_recipients SET status = $2, error = $3 WHERE id = $1", [
        rc.id,
        ok ? "sent" : "failed",
        ok ? null : errMsg,
      ]);
      await c.query(
        "UPDATE broadcasts SET sent_count = sent_count + $2, failed_count = failed_count + $3 WHERE id = $1",
        [broadcastId, ok ? 1 : 0, ok ? 0 : 1],
      );
    });
  }

  if (keepActive) {
    await emitBroadcastUpdated(tenantId, broadcastId, "active");
    return;
  }
  const final = await withTenant(tenantId, async (c) => {
    const r = await c.query(
      "SELECT recipient_count, sent_count, failed_count FROM broadcasts WHERE id = $1",
      [broadcastId],
    );
    if (!r.rowCount) return null;
    const sent = r.rows[0].sent_count as number;
    const failed = r.rows[0].failed_count as number;
    const status = sent === 0 && failed > 0 ? "failed" : "sent";
    await c.query("UPDATE broadcasts SET status = $2, sent_at = now() WHERE id = $1", [broadcastId, status]);
    return status;
  });
  if (final) await emitBroadcastUpdated(tenantId, broadcastId, final);
}

/** One channel-post: build the post body (embed → subject is the title, so don't fold it in;
 *  plain → lead with the bold subject), dispatch ONCE to the target channel with the role-mention
 *  + embed options, record the single recipient row + counters, finalize sent|failed. No merge
 *  tags, no tracking, no unsubscribe — those are per-recipient concerns a single post has none of. */
async function runChannelPost(
  tenantId: string,
  broadcastId: string,
  post: {
    subject: string;
    body: string;
    channel: string;
    targetRef: string;
    mentionRoleId: string | null;
    asEmbed: boolean;
    recipientRowId: string;
  },
  dispatchOverride?: BroadcastDispatchFn,
): Promise<void> {
  const dispatch: BroadcastDispatchFn =
    dispatchOverride ??
    ((ctx, b, o) => {
      const driver = getChannelDriver(post.channel);
      if (!driver?.dispatch) return Promise.resolve({ delivered: false, reason: `no dispatch for channel '${post.channel}'` });
      return driver.dispatch(ctx, b, o);
    });
  const body = post.asEmbed ? post.body : post.subject ? `**${post.subject}**\n\n${post.body}` : post.body;
  let ok = false;
  let errMsg: string | null = null;
  try {
    const res = await dispatch(
      { tenantId, channelType: post.channel, externalChannelId: post.targetRef, subject: post.subject },
      body,
      { mentionRoleId: post.mentionRoleId, asEmbed: post.asEmbed },
    );
    ok = res.delivered;
    if (!ok) errMsg = res.reason ?? "not-delivered";
  } catch (e) {
    ok = false;
    errMsg = (e as Error)?.message ?? "send-error";
  }
  const final = ok ? "sent" : "failed";
  await withTenant(tenantId, async (c) => {
    await c.query("UPDATE broadcast_recipients SET status = $2, error = $3 WHERE id = $1", [
      post.recipientRowId,
      final,
      ok ? null : errMsg,
    ]);
    await c.query(
      "UPDATE broadcasts SET sent_count = sent_count + $2, failed_count = failed_count + $3, status = $4, sent_at = now() WHERE id = $1",
      [broadcastId, ok ? 1 : 0, ok ? 0 : 1, final],
    );
  });
  await emitBroadcastUpdated(tenantId, broadcastId, final);
}

/**
 * One continuous-broadcast tick: re-resolve the audience and send ONCE to every contact not
 * already in broadcast_recipients (the per-(broadcast,contact) dedupe — a contact who
 * matched before, got the message, then left and re-entered the segment is NOT re-sent).
 * Reaches stop_at → 'stopped'. Returns what happened for the scheduler's log / tests.
 */
export async function runContinuousTick(
  tenantId: string,
  id: string,
  opts: { send?: BroadcastSendFn; dispatch?: BroadcastDispatchFn; now?: Date } = {},
): Promise<{ status: string; sent: number; done?: Promise<void> } | null> {
  const send = opts.send ?? defaultSend;
  const now = opts.now ?? new Date();

  const prep = await withTenant(tenantId, async (c) => {
    const cur = await c.query(
      "SELECT status, stop_at, subject, body, channel, template_id, blocks, segment FROM broadcasts WHERE id = $1",
      [id],
    );
    if (!cur.rowCount) return { kind: "not-found" as const };
    if (cur.rows[0].status !== "active") return { kind: "not-active" as const, status: cur.rows[0].status as string };
    const stopAt = cur.rows[0].stop_at ? new Date(cur.rows[0].stop_at as string) : null;
    if (stopAt && stopAt.getTime() <= now.getTime()) {
      await c.query("UPDATE broadcasts SET status = 'stopped' WHERE id = $1", [id]);
      return { kind: "stopped" as const };
    }
    const channel = cur.rows[0].channel as string;
    const segment = cur.rows[0].segment as Record<string, unknown>;
    const already = await c.query(
      "SELECT contact_id FROM broadcast_recipients WHERE broadcast_id = $1 AND contact_id IS NOT NULL",
      [id],
    );
    const seen = new Set((already.rows as { contact_id: string }[]).map((r) => r.contact_id));
    const fresh = (await resolveRecipients(c, channel, segment)).filter((rc) => !seen.has(rc.id));
    if (!fresh.length) return { kind: "idle" as const };
    const inserted: SendRecipient[] = [];
    for (const rc of fresh) {
      const ins = await c.query(
        `INSERT INTO broadcast_recipients (tenant_id, broadcast_id, contact_id, handle, status)
         VALUES (current_tenant(), $1, $2, $3, 'pending') RETURNING id`,
        [id, rc.id, channel === "email" ? rc.handle.toLowerCase() : rc.handle],
      );
      inserted.push({
        id: ins.rows[0].id as string,
        handle: rc.handle,
        contactId: rc.id,
        merge: { name: rc.name, email: rc.email, company: rc.company, attributes: rc.attributes },
      });
    }
    await c.query("UPDATE broadcasts SET recipient_count = recipient_count + $2 WHERE id = $1", [
      id,
      inserted.length,
    ]);
    const parsedBlocks = BroadcastBlocks.safeParse(cur.rows[0].blocks);
    return {
      kind: "ready" as const,
      subject: cur.rows[0].subject as string,
      body: (cur.rows[0].body as string) ?? "",
      channel,
      templateId: cur.rows[0].template_id as string,
      blocks: parsedBlocks.success ? parsedBlocks.data : null,
      recipients: inserted,
    };
  });

  if (prep.kind === "not-found") return null;
  if (prep.kind === "not-active") return { status: prep.status, sent: 0 };
  if (prep.kind === "stopped") {
    await emitBroadcastUpdated(tenantId, id, "stopped");
    return { status: "stopped", sent: 0 };
  }
  if (prep.kind === "idle") return { status: "active", sent: 0 };

  const done = runSend(
    tenantId,
    id,
    prep.channel,
    prep.templateId,
    prep.subject,
    prep.body,
    prep.blocks,
    prep.recipients,
    send,
    opts.dispatch,
    true, // keepActive
  ).catch(() => {});
  return { status: "active", sent: prep.recipients.length, done };
}

/**
 * Walk a broadcast back from an armed state: 'scheduled' → 'draft' (send_at kept so the
 * composer can re-arm or edit it), 'active' → 'stopped'. Anything else is unchanged.
 */
export async function cancelBroadcast(
  tenantId: string,
  id: string,
): Promise<{ status: string } | null> {
  const out = await withTenant(tenantId, async (c) => {
    const cur = await c.query("SELECT status FROM broadcasts WHERE id = $1", [id]);
    if (!cur.rowCount) return null;
    const status = cur.rows[0].status as string;
    if (status === "scheduled") {
      await c.query("UPDATE broadcasts SET status = 'draft' WHERE id = $1", [id]);
      return { status: "draft", changed: true };
    }
    if (status === "active") {
      await c.query("UPDATE broadcasts SET status = 'stopped' WHERE id = $1", [id]);
      return { status: "stopped", changed: true };
    }
    return { status, changed: false };
  });
  if (out?.changed) await emitBroadcastUpdated(tenantId, id, out.status);
  return out ? { status: out.status } : null;
}
