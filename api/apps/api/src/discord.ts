import { relayPool, withTenant } from "@repo/db";
import { ingestInbound, type IngestResult } from "./ingest.js";
import { persistInboundAttachments } from "./attachments.js";
import { getDiscordSender, getMirrorTransport } from "./discord-gateway.js";
import { classifyDiscordAuthor } from "./discord-classify.js";

/** Options a channel-post carries beyond the body (Phase 4). A ticket reply passes none — it
 *  posts plain, pings nothing. A broadcast channel-post may ping ONE role (allowedMentions-gated
 *  so nothing else ever pings) and/or render as an embed titled by the broadcast subject. */
export interface SendOptions {
  mentionRoleId?: string | null;
  asEmbed?: boolean;
  title?: string | null;
}

/** Outbound sender signature. The gateway supplies the real one (chunks >2000-char bodies via
 *  splitForDiscord + honors SendOptions); tests inject a mock. `opts` is optional so existing
 *  ticket-reply callers and mock senders stay source-compatible. */
export type Sender = (channelId: string, content: string, opts?: SendOptions) => Promise<void>;

/** A Discord attachment carried through the inbound seam (content union, §5.4). */
export interface DiscordAttachment {
  url: string;
  filename: string;
  contentType: string;
  size: number;
}

/**
 * Resolve a Discord guild to its tenant. Reads discord_links via the BYPASSRLS
 * relay role: this lookup runs BEFORE any tenant context exists (it is how we find
 * the tenant), so it cannot sit behind RLS — discord_links is deliberately unpolicied.
 */
export async function resolveTenant(guildId: string): Promise<string | null> {
  const r = await relayPool.query(
    "SELECT tenant_id FROM discord_links WHERE guild_id = $1",
    [guildId],
  );
  return r.rowCount ? (r.rows[0].tenant_id as string) : null;
}

/** Bind a guild to a tenant (onboarding: the customer invites the bot, we link the server). */
export async function linkGuild(guildId: string, tenantId: string): Promise<void> {
  await relayPool.query(
    "INSERT INTO discord_links (guild_id, tenant_id) VALUES ($1, $2) ON CONFLICT (guild_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id",
    [guildId, tenantId],
  );
}

/** The resolved monitoring decision for a channel (§5.8). */
interface Binding {
  mode: string;          // 'staffed' | 'community' | 'off'
  require_thread: boolean;
  kind: string;
  /** VIP channels (D5): each top-level customer message → new ticket + bot-anchored thread. */
  thread_per_message: boolean;
}

/**
 * Resolve whether a channel is monitored + how (§5.8). All reads go through relayPool
 * (discord_channel_bindings is OUTSIDE RLS, like discord_links). Rules:
 *  - Guild has ZERO bindings → default-allow fallback: treat as monitored under the guild's
 *    default_mode and lazily seed a binding for this channel (so existing links don't go dark),
 *    which flips the guild into explicit allow-list mode on the first binding.
 *  - Guild has ≥1 binding → allow-list: the channel (or its parent) must be explicitly bound and
 *    not mode='off', else return null (ignore).
 */
async function resolveBinding(
  guildId: string,
  channelId: string,
  parentId: string | null,
): Promise<Binding | null> {
  const all = await relayPool.query(
    "SELECT channel_id, mode, require_thread, kind, thread_per_message FROM discord_channel_bindings WHERE guild_id = $1",
    [guildId],
  );
  if (all.rowCount === 0) {
    const link = await relayPool.query(
      "SELECT tenant_id, default_mode FROM discord_links WHERE guild_id = $1",
      [guildId],
    );
    if (!link.rowCount) return null;
    const mode = (link.rows[0].default_mode as string) ?? "staffed";
    const tenantId = link.rows[0].tenant_id as string;
    // Seed a binding for the channel (or its parent, for a thread) so the guild flips to allow-list.
    const bindChannel = parentId ?? channelId;
    await relayPool.query(
      `INSERT INTO discord_channel_bindings (guild_id, channel_id, tenant_id, mode)
       VALUES ($1, $2, $3, $4) ON CONFLICT (guild_id, channel_id) DO NOTHING`,
      [guildId, bindChannel, tenantId, mode],
    );
    return { mode, require_thread: true, kind: "text", thread_per_message: false };
  }
  const rows = all.rows as { channel_id: string; mode: string; require_thread: boolean; kind: string; thread_per_message: boolean }[];
  const match =
    rows.find((r) => r.channel_id === channelId) ??
    (parentId ? rows.find((r) => r.channel_id === parentId) : undefined);
  if (!match || match.mode === "off") return null;
  return { mode: match.mode, require_thread: match.require_thread, kind: match.kind, thread_per_message: match.thread_per_message };
}

export interface InboundDiscordMessage {
  guildId: string;
  /** The channel the message lives in — for a thread message this IS the thread id (discord.js). */
  channelId: string;
  authorId: string;
  content: string;
  discordMessageId: string;
  threadId?: string | null;
  parentId?: string | null;                                 // forum/text channel the thread hangs under
  threadKind?: "text_thread" | "forum_post" | "channel" | null;
  authorDisplayName?: string | null;
  authorAvatarUrl?: string | null;
  attachments?: DiscordAttachment[];
  embeds?: { title?: string | null; description?: string | null; url?: string | null }[];
  /** Thread / forum-post title — the content-union fallback body for a title-only starter. */
  threadName?: string | null;
  roleIds?: string[];                                       // §5.10 — wired for the Phase-2 classifier
  memberIsNull?: boolean;
  isBotOrWebhook?: boolean;
  skipAutoreply?: boolean;
}

/** Content union (§5.4): the message body is the text, else the forum-post title, else an
 *  attachment/embed-derived placeholder — so attachment-only / embed-only / title-only inbound is
 *  no longer silently dropped. Returns "" only when there is genuinely nothing. */
function composeBody(m: InboundDiscordMessage): string {
  const text = (m.content ?? "").trim();
  if (text) return m.content;
  if (m.threadKind === "forum_post" && m.threadName) return m.threadName;
  const embed = (m.embeds ?? []).find((e) => e.title || e.description || e.url);
  if (embed) return embed.title || embed.description || embed.url || "[embed]";
  const atts = m.attachments ?? [];
  if (atts.length > 0) {
    const a = atts[0];
    return (a.contentType ?? "").startsWith("image/") ? "[image]" : `[${a.filename || "attachment"}]`;
  }
  if (m.threadName) return m.threadName;
  return "";
}

/**
 * The inbound seam (tested without a live gateway): resolve the guild's tenant, apply channel
 * scoping + the content union, then ingest with the THREAD threading policy so a Discord thread is
 * ONE ticket keyed on its thread id (not collapsed onto the contact). Returns null when the message
 * is dropped (DM / bot / unlinked / unbound / off / top-level-in-a-thread-only-binding / empty).
 * A community-mode binding is NOT dropped — it ingests with support_mode='community' (Phase 3, §5.1).
 * The Discord message id is the idempotency key, so redelivery dedupes the write for free.
 */
export async function handleInboundMessage(
  m: InboundDiscordMessage,
): Promise<IngestResult | null> {
  if (!m.guildId) return null;         // DM — explicitly dropped (Decision 10)
  if (m.isBotOrWebhook) return null;   // our own replies + other bots/webhooks (no echo loop)
  const tenantId = await resolveTenant(m.guildId);
  if (!tenantId) return null;

  const threadKind = m.threadKind ?? "channel";
  const isThread = threadKind === "text_thread" || threadKind === "forum_post";
  const binding = await resolveBinding(m.guildId, m.channelId, m.parentId ?? null);
  if (!binding) return null;                             // unbound / off / unlinked
  // VIP channels (D5): a top-level CUSTOMER message is a NEW ticket — the bot anchors a Discord
  // thread on the message and the ticket keys on that thread id, so follow-ups ride the normal
  // thread=ticket path. Top-level agent/teammate chatter never mints tickets (reply in-thread).
  if (!isThread && binding.thread_per_message) {
    return handleVipTopLevelMessage(m, binding, tenantId);
  }
  if (binding.require_thread && !isThread) return null;  // top-level ignored (Decision 2)
  // Phase 3: community-mode channels are now INGESTED (for the record + KB + analytics), frozen
  // support_mode='community' → excluded from the agent queue/SLA (read-site sweep, §5.1) and the AI
  // "deflects once" then observes (§5.5). Only mode='off' (→ resolveBinding returns null) is dropped.
  const supportMode = binding.mode === "community" ? "community" : "staffed";

  // Per-message author classification (Phase 2, §5.10). Precedence explicit-mark > role > default.
  // A teammate maps to their Noola seat (authorType 'agent'); an external mod is a first-class
  // community identity (authorType 'agent', kind 'community', NO Noola seat, NO phantom contact);
  // an ignore-role author is dropped; everyone else is a customer/seeker.
  const cls = await classifyDiscordAuthor({
    tenantId,
    guildId: m.guildId,
    authorId: m.authorId,
    roleIds: m.roleIds ?? [],
  });
  if (cls.action === "drop") return null;
  const isSeeker = cls.authorType === "customer";

  const body = composeBody(m);
  if (body.trim().length === 0 && (m.attachments ?? []).length === 0) return null; // content union: nothing usable

  // Thread = ticket keyed on the Discord thread id (§5.7). For Discord the thread id IS the stable
  // reply target, so external_channel_id === external_thread_id (no retarget hopping).
  const threadId = m.threadId ?? m.channelId;
  const result = await ingestInbound({
    tenantId,
    body,
    authorType: cls.authorType,
    idempotencyKey: `discord:${m.discordMessageId}`,
    channelType: "discord",
    externalChannelId: threadId,
    threadingPolicy: "thread",
    externalThreadId: threadId,
    externalParentId: m.parentId ?? null,
    externalThreadKind: threadKind,
    externalGuildId: m.guildId,
    supportMode,
    authorKind: cls.authorKind,
    authorId: cls.authorId,
    authorExternalName: m.authorDisplayName ?? null,
    authorExternalAvatarUrl: m.authorAvatarUrl ?? null,
    authorExternalId: m.authorId,
    // Only a seeker resolves/creates a contact; teammates + community responders never mint one
    // (refuted-claim #2). Passing identity is harmless — ingest ignores it for non-customer authors.
    identity: isSeeker ? { externalId: m.authorId, name: m.authorDisplayName ?? null } : undefined,
    skipAutoreply: m.skipAutoreply ?? false,
  });

  // Persist inbound attachments best-effort, post-commit (mirrors the reply route's claim pattern).
  if (result && !result.replay && (m.attachments ?? []).length > 0) {
    await persistInboundAttachments(tenantId, result.ticketId, result.messageId, m.attachments!).catch(() => {});
  }
  // Channel→account rollup (D5, Slack parity): a seeker seen in a bound channel inherits the
  // channel's company when unattributed. Keyed on the PARENT channel for thread messages.
  if (result && !result.replay && result.contactId) {
    await applyDiscordChannelAccount(tenantId, m.guildId, m.parentId ?? m.channelId, result.contactId).catch(() => {});
  }
  return result;
}

/**
 * VIP thread-per-message (D5): classify the top-level author; only a SEEKER mints a ticket. The bot
 * anchors a thread on the message (best-effort — a permissions failure degrades to keying the
 * ticket on the message id, so per-message ticketing still holds), then ingests with the thread id
 * as the ticket key. The author's own MESSAGE_CREATE for in-thread follow-ups rides the normal
 * thread path onto the same ticket.
 */
async function handleVipTopLevelMessage(m: InboundDiscordMessage, binding: Binding, tenantId: string): Promise<IngestResult | null> {
  const cls = await classifyDiscordAuthor({
    tenantId,
    guildId: m.guildId,
    authorId: m.authorId,
    roleIds: m.roleIds ?? [],
  });
  if (cls.action === "drop" || cls.authorType !== "customer") return null; // agents reply in-thread

  const body = composeBody(m);
  if (body.trim().length === 0 && (m.attachments ?? []).length === 0) return null;

  const anchored = await getMirrorTransport()
    ?.createMessageThread(m.channelId, m.discordMessageId, body.slice(0, 90) || "Conversation")
    .catch(() => null);
  const threadId = anchored?.threadId ?? m.discordMessageId; // fallback: message id still isolates the ticket

  const result = await ingestInbound({
    tenantId,
    body,
    authorType: "customer",
    idempotencyKey: `discord:${m.discordMessageId}`,
    channelType: "discord",
    externalChannelId: threadId,
    threadingPolicy: "thread",
    externalThreadId: threadId,
    externalParentId: m.channelId,
    externalThreadKind: "text_thread",
    externalGuildId: m.guildId,
    supportMode: binding.mode === "community" ? "community" : "staffed",
    authorKind: "customer",
    authorExternalName: m.authorDisplayName ?? null,
    authorExternalAvatarUrl: m.authorAvatarUrl ?? null,
    identity: { externalId: m.authorId, name: m.authorDisplayName ?? null },
    skipAutoreply: m.skipAutoreply ?? false,
  });
  if (result && !result.replay && (m.attachments ?? []).length > 0) {
    await persistInboundAttachments(tenantId, result.ticketId, result.messageId, m.attachments!).catch(() => {});
  }
  if (result && !result.replay && result.contactId) {
    await applyDiscordChannelAccount(tenantId, m.guildId, m.channelId, result.contactId).catch(() => {});
  }
  return result;
}

// ── customer-channel bindings management (D5 settings surface) ────────────────
// The bindings table is relay-scoped (resolved pre-tenant on the gateway hot path); the API
// scopes every read/write by tenant_id in the query, like discord_links.

export interface ChannelBindingRow {
  guild_id: string;
  channel_id: string;
  mode: string;
  require_thread: boolean;
  thread_per_message: boolean;
  kind: string;
  autoreply_mode: string | null;
}

export async function listDiscordChannelBindings(tenantId: string): Promise<ChannelBindingRow[]> {
  const r = await relayPool.query(
    `SELECT guild_id, channel_id, mode, require_thread, thread_per_message, kind, autoreply_mode
       FROM discord_channel_bindings WHERE tenant_id = $1 ORDER BY created_at ASC`,
    [tenantId],
  );
  return r.rows as ChannelBindingRow[];
}

/** Full-replace the tenant's channel bindings (Settings save model). Rows for other tenants are
 *  untouched; removing a binding returns that channel to unmonitored. */
export async function replaceDiscordChannelBindings(
  tenantId: string,
  entries: { guildId: string; channelId: string; kind?: string; mode: string; requireThread: boolean; threadPerMessage: boolean; autoreplyMode?: string | null }[],
): Promise<ChannelBindingRow[]> {
  for (const e of entries) {
    await relayPool.query(
      `INSERT INTO discord_channel_bindings (guild_id, channel_id, tenant_id, kind, mode, require_thread, thread_per_message, autoreply_mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (guild_id, channel_id) DO UPDATE SET
         kind = EXCLUDED.kind, mode = EXCLUDED.mode, require_thread = EXCLUDED.require_thread,
         thread_per_message = EXCLUDED.thread_per_message, autoreply_mode = EXCLUDED.autoreply_mode
       WHERE discord_channel_bindings.tenant_id = $3`,
      [e.guildId, e.channelId, tenantId, e.kind ?? "text", e.mode, e.requireThread, e.threadPerMessage, e.autoreplyMode ?? null],
    );
  }
  const keep = entries.map((e) => `${e.guildId}:${e.channelId}`);
  await relayPool.query(
    `DELETE FROM discord_channel_bindings WHERE tenant_id = $1 AND NOT (guild_id || ':' || channel_id = ANY($2::text[]))`,
    [tenantId, keep],
  );
  return listDiscordChannelBindings(tenantId);
}

// ── channel → company account binding (D5, mirrors slack_channel_accounts) ────

export async function setDiscordChannelAccount(tenantId: string, guildId: string, channelId: string, companyId: string): Promise<void> {
  await withTenant(tenantId, async (c) => {
    await c.query(
      `INSERT INTO discord_channel_accounts (tenant_id, guild_id, channel_id, company_id) VALUES (current_tenant(), $1, $2, $3)
       ON CONFLICT (tenant_id, guild_id, channel_id) DO UPDATE SET company_id = EXCLUDED.company_id`,
      [guildId, channelId, companyId],
    );
  });
}

export async function unsetDiscordChannelAccount(tenantId: string, guildId: string, channelId: string): Promise<boolean> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query("DELETE FROM discord_channel_accounts WHERE guild_id = $1 AND channel_id = $2", [guildId, channelId]);
    return (r.rowCount ?? 0) > 0;
  });
}

export async function listDiscordChannelAccounts(tenantId: string): Promise<{ guild_id: string; channel_id: string; company_id: string; company_name: string | null }[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT a.guild_id, a.channel_id, a.company_id, co.name AS company_name
         FROM discord_channel_accounts a
         LEFT JOIN companies co ON co.tenant_id = a.tenant_id AND co.id = a.company_id
        ORDER BY a.created_at ASC`,
    );
    return r.rows as { guild_id: string; channel_id: string; company_id: string; company_name: string | null }[];
  });
}

/** Attribute an unattributed contact to the channel's bound company (no-op without a binding). */
export async function applyDiscordChannelAccount(tenantId: string, guildId: string, channelId: string, contactId: string): Promise<void> {
  await withTenant(tenantId, async (c) => {
    const b = await c.query("SELECT company_id FROM discord_channel_accounts WHERE guild_id = $1 AND channel_id = $2", [guildId, channelId]);
    if (!b.rowCount) return;
    await c.query("UPDATE contacts SET company_id = $1, updated_at = now() WHERE id = $2 AND company_id IS NULL", [b.rows[0].company_id, contactId]);
  });
}

export interface ThreadCreateInput {
  guildId: string;
  threadId: string;
  parentId: string | null;
  ownerId: string | null;
  name: string | null;
  kind: "text_thread" | "forum_post";
  ownerDisplayName?: string | null;
  ownerAvatarUrl?: string | null;
  /** The owner's Discord role ids, when the gateway can supply them — feeds classifyDiscordAuthor so a
   *  teammate/responder who opens a thread isn't mis-seated as a customer. */
  ownerRoleIds?: string[];
}

/**
 * ThreadCreate (§5.6) — the only reliable source of the forum-starter/ownerId (it's on the thread
 * object, not the first MESSAGE_CREATE). Pre-seats the ticket + seats the owner as the customer. The
 * starter's own MESSAGE_CREATE (dedup'd by its message id) then appends the real message onto the
 * same ticket via the thread upsert. Idempotent on the thread id.
 */
export async function handleThreadCreate(t: ThreadCreateInput): Promise<IngestResult | null> {
  if (!t.guildId || !t.ownerId) return null;
  const tenantId = await resolveTenant(t.guildId);
  if (!tenantId) return null;
  const binding = await resolveBinding(t.guildId, t.threadId, t.parentId);
  if (!binding) return null;  // unbound / off — community threads ARE seated (Phase 3)
  // Classify the owner instead of assuming 'customer': a marked teammate / team-role member opening a
  // thread is not a seeker, so we must NOT pre-seat a customer ticket or mint a phantom contact for
  // them. Only a genuine seeker gets seated (their first message rides the normal thread path).
  const cls = await classifyDiscordAuthor({ tenantId, guildId: t.guildId, authorId: t.ownerId, roleIds: t.ownerRoleIds ?? [] });
  if (cls.action === "drop" || cls.authorType !== "customer") return null;
  return ingestInbound({
    tenantId,
    body: t.name ?? "[thread]",
    authorType: "customer",
    idempotencyKey: `discord:thread:${t.threadId}`,
    channelType: "discord",
    externalChannelId: t.threadId,
    threadingPolicy: "thread",
    externalThreadId: t.threadId,
    externalParentId: t.parentId,
    externalThreadKind: t.kind,
    externalGuildId: t.guildId,
    supportMode: binding.mode === "community" ? "community" : "staffed",
    authorKind: "customer",
    authorExternalName: t.ownerDisplayName ?? null,
    authorExternalAvatarUrl: t.ownerAvatarUrl ?? null,
    authorExternalId: t.ownerId,
    identity: { externalId: t.ownerId, name: t.ownerDisplayName ?? null },
    skipAutoreply: true, // a thread-create seat is not a customer question turn
  });
}

export interface MessageUpdateInput {
  guildId: string;
  messageId: string;
  newContent: string;
  attachments?: DiscordAttachment[];
}

/** MessageUpdate (§5.6) — re-ingest an edit IN PLACE by matching the existing discord:<id> row and
 *  updating its body; never mint a new message. Returns true iff a row was updated. */
export async function handleMessageUpdate(u: MessageUpdateInput): Promise<boolean> {
  const tenantId = await resolveTenant(u.guildId);
  if (!tenantId) return false;
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      "UPDATE messages SET body = $2 WHERE idempotency_key = $1 RETURNING id",
      [`discord:${u.messageId}`, u.newContent],
    );
    return (r.rowCount ?? 0) > 0;
  });
}

export interface MessageDeleteInput {
  guildId: string;
  messageId: string;
}

/** MessageDelete (§5.6) — soft-tombstone the message (keep the row for audit). If it was the ONLY
 *  non-deleted customer message on the ticket, close the ticket (deleted-by-author, no orphan). */
export async function handleMessageDelete(d: MessageDeleteInput): Promise<boolean> {
  const tenantId = await resolveTenant(d.guildId);
  if (!tenantId) return false;
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      "UPDATE messages SET deleted_at = now() WHERE idempotency_key = $1 AND deleted_at IS NULL RETURNING ticket_id",
      [`discord:${d.messageId}`],
    );
    if (!r.rowCount) return false;
    const ticketId = r.rows[0].ticket_id as string;
    const remaining = await c.query(
      "SELECT count(*)::int AS n FROM messages WHERE ticket_id = $1 AND author_type = 'customer' AND deleted_at IS NULL",
      [ticketId],
    );
    if ((remaining.rows[0].n as number) === 0) {
      // Proper close (status_category + closed_at), then the domain event — so CSAT/QA/knowledge/mirror
      // fire like any other close, not a bare status flip that also drops out of the closed view.
      await c.query(
        "UPDATE tickets SET status = 'closed', status_category = 'closed', closed_at = now(), updated_at = now() WHERE id = $1",
        [ticketId],
      );
      const { emitDomainEvent } = await import("./automations.js");
      emitDomainEvent(tenantId, "ticket.closed", { ticketId, source: "discord", closeReason: "last_customer_message_deleted" });
    }
    return true;
  });
}

/** Close a Discord-origin (intake) ticket resolved from its thread, the SAME way the console close
 *  route does — proper status/status_category/closed_at, resolved-thread knowledge indexing, and the
 *  ticket.closed domain event (CSAT/QA/mirror). Idempotent: an already-closed ticket is a no-op, so
 *  the archive→ThreadUpdate echo of a Noola-side close cannot loop. source:'discord' tells the seam
 *  the close began on Discord (don't re-archive the very thread that triggered it). */
async function closeIntakeTicketByThread(tenantId: string, threadId: string, reason: string): Promise<void> {
  const found = await withTenant(tenantId, (c) =>
    c.query(
      "SELECT id FROM tickets WHERE channel_type = 'discord' AND external_thread_id = $1 AND status <> 'closed' LIMIT 1",
      [threadId],
    ),
  );
  if (!found.rowCount) return;
  const ticketId = found.rows[0].id as string;
  const { setTicketStatus } = await import("./tickets.js");
  await setTicketStatus(tenantId, ticketId, "closed");
  const { indexResolvedThread } = await import("./threads.js");
  void indexResolvedThread(tenantId, ticketId).catch(() => {});
  const { emitDomainEvent } = await import("./automations.js");
  emitDomainEvent(tenantId, "ticket.closed", { ticketId, source: "discord", closeReason: reason });
}

/** ThreadUpdate (§5.6) — a Discord-side RESOLVE gesture closes the intake ticket: the thread was
 *  locked, archived, or tagged with a "solved/resolved/closed" forum tag. A plain edit is a no-op.
 *  A later customer message reopens the ticket via the ingest upsert (status closed→open, §I.4). */
export async function handleThreadUpdate(
  guildId: string,
  threadId: string,
  state: { locked?: boolean; archived?: boolean; appliedTagNames?: string[] },
): Promise<void> {
  const solvedTag = (state.appliedTagNames ?? []).some((n) => /solv|resolv|clos|done|complete|answered|fixed/i.test(n));
  if (!state.locked && !state.archived && !solvedTag) return;
  const tenantId = await resolveTenant(guildId);
  if (!tenantId) return;
  const reason = state.archived ? "discord_archived" : state.locked ? "discord_locked" : "discord_solved_tag";
  await closeIntakeTicketByThread(tenantId, threadId, reason);
}

/** ThreadDelete (§5.6) — the thread is gone; close its ticket (properly, with the close event). */
export async function handleThreadDelete(guildId: string, threadId: string): Promise<void> {
  const tenantId = await resolveTenant(guildId);
  if (!tenantId) return;
  await closeIntakeTicketByThread(tenantId, threadId, "discord_thread_deleted");
}

/** A reaction on a Discord-NATIVE (intake) support thread: a marked teammate reacting with a
 *  close-mapped emoji (✅ by default) resolves the ticket — the intake analogue of ops-mirror triage.
 *  Gated to an explicit teammate mark (agent_channel_identities) so a random member can't close
 *  tickets. No-ops for non-intake threads (the mirror handler owns those, checked first upstream). */
export async function handleIntakeReaction(r: {
  guildId: string; threadId: string; reactorId: string; emoji: string;
}): Promise<{ closed: boolean; reason?: string }> {
  const tenantId = await resolveTenant(r.guildId);
  if (!tenantId) return { closed: false, reason: "unbound" };
  const found = await withTenant(tenantId, (c) =>
    c.query(
      "SELECT 1 FROM tickets WHERE channel_type = 'discord' AND external_thread_id = $1 AND status <> 'closed' LIMIT 1",
      [r.threadId],
    ),
  );
  if (!found.rowCount) return { closed: false, reason: "not_intake" };
  const { canonicalEmojiName, getReactionMap } = await import("./classification.js");
  const map = await getReactionMap(tenantId);
  if (map[canonicalEmojiName(r.emoji)] !== "close") return { closed: false, reason: "unmapped_emoji" };
  const { resolveTeammate } = await import("./discord-classify.js");
  if (!(await resolveTeammate(tenantId, r.reactorId))) return { closed: false, reason: "not_teammate" };
  await closeIntakeTicketByThread(tenantId, r.threadId, "discord_reaction");
  return { closed: true };
}

/**
 * The internal sender seam (§5.9). Phase 1 = deliberately INERT: it returns today's single shared
 * sender unchanged. Phase 6 grows this into per-tenant/guild bot resolution (keyed on
 * tickets.external_guild_id, written now); until then routeOutbound's signature + callers are
 * untouched and this is the one place a future manager plugs in.
 */
export function getSender(): Sender | null {
  return getDiscordSender();
}

/**
 * The outbound seam (tested with a mock send): post an agent reply back to the
 * ticket's origin channel. No-ops (with a reason) for non-Discord tickets or when
 * the gateway is not connected — the caller decides whether that's worth logging.
 */
export async function routeOutbound(
  routing: { channelType?: string; externalChannelId?: string | null },
  body: string,
  send: Sender | null,
  opts?: SendOptions,
): Promise<{ delivered: boolean; reason?: string }> {
  if (routing.channelType !== "discord" || !routing.externalChannelId) {
    return { delivered: false, reason: "not-external" };
  }
  if (!send) return { delivered: false, reason: "discord-disconnected" };
  await send(routing.externalChannelId, body, opts);
  return { delivered: true };
}
