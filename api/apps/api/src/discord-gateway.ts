import {
  Client, GatewayIntentBits, Events, ChannelType, Partials, PermissionFlagsBits,
  SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, Routes,
  type ChatInputCommandInteraction, type ButtonInteraction, type Guild,
  type ForumChannel, type ThreadChannel, type Message, type RateLimitData, RateLimitError, type GuildTextBasedChannel,
} from "discord.js";
import { SimpleShardingStrategy, type WebSocketManager } from "@discordjs/ws";
import type { Agent as HttpAgent } from "node:http";
import { relayPool } from "@repo/db";
import { discordEgress, proxiedMakeRequest } from "./discord-egress.js";
import { backfillChannels, lastSeenConnected, loadGuildScopes, recordSeenConnected, type BackfillChannel } from "./discord-backfill.js";
import { isDiscordEventLeader, probeDiscordLeaderNow, startDiscordLeaderElection } from "./discord-leader.js";
import { discordTokensToText, splitForDiscord } from "./channels/format.js";
import {
  handleInboundMessage,
  handleThreadCreate,
  handleThreadUpdate,
  handleThreadDelete,
  handleMessageUpdate,
  handleMessageDelete,
  type Sender,
} from "./discord.js";
import { handleAskCommand, handleDraftCommand, postDraft } from "./discord-commands.js";
import {
  listStartableTenantBots, countStartableTenantBots,
  markBotReady, markBotDisconnect, quarantineBot,
} from "./discord-bots.js";

type Log = {
  info: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
  error: (...a: unknown[]) => void;
};

// One live outbound sender per open bot, keyed by botId ('shared' for the platform bot, the
// discord_bots.id for a per-tenant BYO bot). routeOutbound() with no botId uses the shared sender —
// unchanged behaviour for the single-bot deployment; per-guild bot routing is a prod-multibot concern.
const senders = new Map<string, Sender>();
const clients = new Map<string, Client>();
// When each open bot's gateway was last connected: null while connected, a timestamp while not.
const gatewayDownSince = new Map<string, number | null>();

let senderOverride: Sender | null = null;
export function setDiscordSenderForTests(s: Sender | null): void {
  senderOverride = s;
}

/** The live outbound sender for a bot ('shared' by default), or null when it's disabled/unconnected. */
export function getDiscordSender(botId = "shared"): Sender | null {
  return senderOverride ?? senders.get(botId) ?? senders.get("shared") ?? null;
}

// ── Forum ops-mirror transport (discord-mirror.ts) ─────────────────────────────
// The mirror engine's Discord surface: forum-post CRUD, tag sync, archive, reactions, role reads.
// Same registry shape as senders; tests inject a mock via setMirrorTransportForTests.
/** A file to upload alongside a Discord message (customer/agent attachment mirrored into the thread). */
export interface MirrorFile {
  name: string;
  data: Buffer;
}

export interface MirrorTransport {
  /** Forum channels the bot can see in a guild (Settings picker). */
  listForums(guildId: string): Promise<{ id: string; name: string }[]>;
  /** Roles in a guild (responder-role picker). */
  listRoles(guildId: string): Promise<{ id: string; name: string }[]>;
  /** Text channels in a guild (VIP customer-channel picker). */
  listTextChannels(guildId: string): Promise<{ id: string; name: string }[]>;
  /** Create one forum post; ensures the tag names exist on the forum (best-effort) and applies them.
   *  Optional `files` upload as Discord attachments on the initial post message. */
  createForumPost(forumChannelId: string, name: string, content: string, tagNames: string[], files?: MirrorFile[]): Promise<{ threadId: string } | null>;
  /** Anchor a thread on an existing channel message (VIP thread-per-message bindings, D5). */
  createMessageThread(channelId: string, messageId: string, name: string): Promise<{ threadId: string } | null>;
  /** Post into a thread; optional `files` upload as Discord attachments (on the first content chunk).
   *  `opts.nonce` (<= 21 chars) is sent per chunk with enforce_nonce, so a retried write whose earlier
   *  attempt already landed is collapsed by Discord instead of posting a second copy. */
  postToThread(threadId: string, content: string, files?: MirrorFile[], mentionUserIds?: string[], opts?: { nonce?: string }): Promise<boolean>;
  setArchived(threadId: string, archived: boolean): Promise<boolean>;
  applyTags(threadId: string, tagNames: string[]): Promise<boolean>;
  /** Parent-forum tag names for a thread — used to detect an existing "Solved/Resolved" tag. */
  forumTagNames?(threadId: string): Promise<string[]>;
  /** Current archived state of a thread. Used to make a Noola-side close idempotent — skip the
   *  "Marked resolved" notice + re-archive when the origin thread is already archived (e.g. it was
   *  closed on Discord but that close never synced back). null = couldn't read the thread. */
  threadArchived?(threadId: string): Promise<boolean | null>;
  /** Available tag names on a FORUM channel (Settings picker for the per-binding close tag). */
  listForumTags?(channelId: string): Promise<string[]>;
  /** Lock a thread (per-binding close action). Optional, like forumTagNames. */
  setLocked?(threadId: string, locked: boolean): Promise<boolean>;
  react(threadId: string, messageId: string, emoji: string): Promise<boolean>;
  memberRoleIds(guildId: string, userId: string): Promise<string[]>;
}
/** Map our provider-agnostic MirrorFile[] to discord.js's message `files` shape. */
function toDiscordFiles(files?: MirrorFile[]): { attachment: Buffer; name: string }[] {
  return (files ?? []).map((f) => ({ attachment: f.data, name: f.name }));
}

const mirrorTransports = new Map<string, MirrorTransport>();

// Test seam shared by every consumer (mirror engine + the VIP thread-per-message path): tests
// inject a mock; production resolves the live per-bot transport.
let transportOverride: MirrorTransport | null = null;
export function setDiscordTransportForTests(t: MirrorTransport | null): void {
  transportOverride = t;
}

export function getMirrorTransport(botId = "shared"): MirrorTransport | null {
  return transportOverride ?? mirrorTransports.get(botId) ?? mirrorTransports.get("shared") ?? null;
}

/** Resolve tag names → forum tag ids, creating missing tags when the bot may (Manage Channels).
 *  Best-effort: a forum at the 20-tag cap or a permission refusal degrades to whatever resolved. */
async function resolveForumTagIds(forum: ForumChannel, tagNames: string[]): Promise<string[]> {
  const want = tagNames.map((n) => n.toLowerCase()).filter(Boolean);
  const have = new Map(forum.availableTags.map((t) => [t.name.toLowerCase(), t.id]));
  const missing = want.filter((n) => !have.has(n));
  if (missing.length && forum.availableTags.length + missing.length <= 20) {
    try {
      const next = await forum.setAvailableTags([
        ...forum.availableTags.map((t) => ({ id: t.id, name: t.name, moderated: t.moderated, emoji: t.emoji })),
        ...missing.map((n) => ({ name: n })),
      ] as never);
      for (const t of next.availableTags) have.set(t.name.toLowerCase(), t.id);
    } catch { /* no Manage Channels — apply what exists */ }
  }
  return want.map((n) => have.get(n)).filter((id): id is string => !!id).slice(0, 5);
}

/** Discord (discord.js) fetches await the gateway/REST queue and can HANG indefinitely when the bot's
 *  connection is degraded — `.catch()` only handles rejection, not a never-settling promise. The
 *  settings endpoints await these inline, so a stalled fetch hangs the HTTP request until the gateway
 *  kills it with a 504. Bound every fetch: on timeout REJECT so the caller's existing `.catch(() => …)`
 *  degrades to the same empty result it uses for "bot offline". */
const DISCORD_FETCH_TIMEOUT_MS = 5000;
function withTimeout<T>(p: Promise<T>, ms = DISCORD_FETCH_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("discord fetch timeout")), ms);
    if (typeof t.unref === "function") t.unref();
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

const THREAD_ALREADY_EXISTS = 160004;
const PAYLOAD_TOO_LARGE = 40005;

/** Discord refused the upload as larger than the server's limit. */
function uploadTooLarge(e: unknown): boolean {
  const err = e as { code?: unknown; status?: unknown } | null;
  return err?.code === PAYLOAD_TOO_LARGE || err?.status === 413;
}

function filesNotUploadedNote(n: number): string {
  return `_(${n} attachment${n > 1 ? "s were" : " was"} too large to upload to Discord - open the ticket in Noola to see ${n > 1 ? "them" : "it"})_`;
}

function buildMirrorTransport(client: Client): MirrorTransport {
  const forum = async (id: string): Promise<ForumChannel | null> => {
    const ch = await client.channels.fetch(id).catch(() => null);
    return ch?.type === ChannelType.GuildForum ? (ch as ForumChannel) : null;
  };
  // `rethrowRateLimit` lets a forum-state edit report a fail-fast rate limit, so the mirror sync can retry it.
  const thread = async (id: string, rethrowRateLimit = false): Promise<ThreadChannel | null> => {
    const ch = await client.channels.fetch(id).catch((e: unknown) => {
      if (rethrowRateLimit && e instanceof RateLimitError) throw e;
      return null;
    });
    return ch && "isThread" in ch && (ch as ThreadChannel).isThread() ? (ch as ThreadChannel) : null;
  };
  return {
    async listForums(guildId) {
      const guild = await withTimeout(client.guilds.fetch(guildId)).catch(() => null);
      if (!guild) return [];
      const channels = await withTimeout(guild.channels.fetch()).catch(() => null);
      if (!channels) return [];
      return [...channels.values()]
        .filter((c) => c?.type === ChannelType.GuildForum)
        .map((c) => ({ id: c!.id, name: c!.name }));
    },
    async listRoles(guildId) {
      const guild = await withTimeout(client.guilds.fetch(guildId)).catch(() => null);
      if (!guild) return [];
      const roles = await withTimeout(guild.roles.fetch()).catch(() => null);
      if (!roles) return [];
      return [...roles.values()].filter((r) => r.name !== "@everyone").map((r) => ({ id: r.id, name: r.name }));
    },
    async listTextChannels(guildId) {
      const guild = await withTimeout(client.guilds.fetch(guildId)).catch(() => null);
      if (!guild) return [];
      const channels = await withTimeout(guild.channels.fetch()).catch(() => null);
      if (!channels) return [];
      return [...channels.values()]
        .filter((c) => c?.type === ChannelType.GuildText)
        .map((c) => ({ id: c!.id, name: c!.name }));
    },
    async createForumPost(forumChannelId, name, content, tagNames, files) {
      const f = await forum(forumChannelId);
      if (!f) return null;
      const appliedTags = await resolveForumTagIds(f, tagNames).catch(() => []);
      const df = toDiscordFiles(files);
      const create = (body: string, withFiles: boolean) => {
        const chunks = splitForDiscord(body, 2000);
        return f.threads.create({
          name: name.slice(0, 100) || "Support ticket",
          message: { content: chunks[0], allowedMentions: { parse: [] }, ...(withFiles && df.length ? { files: df } : {}) },
          appliedTags,
        }).then((thread) => ({ thread, chunks }));
      };
      // Without the files the post still lands, so a too-large upload doesn't lose the whole mirror.
      const made = await create(content, true).catch((e: unknown) =>
        df.length && uploadTooLarge(e) ? create(`${content}\n${filesNotUploadedNote(df.length)}`, false).catch(() => null) : null,
      );
      if (!made) return null;
      const { thread: created, chunks } = made;
      for (let i = 1; i < chunks.length; i++) {
        await created.send({ content: chunks[i], allowedMentions: { parse: [] } }).catch(() => {});
      }
      return { threadId: created.id };
    },
    async createMessageThread(channelId, messageId, name) {
      const ch = await client.channels.fetch(channelId).catch(() => null);
      if (!(ch && "messages" in ch)) return null;
      const msg = await (ch as { messages: { fetch: (id: string) => Promise<{ startThread: (o: { name: string }) => Promise<{ id: string }> } | null> } }).messages
        .fetch(messageId).catch(() => null);
      if (!msg) return null;
      const t = await msg.startThread({ name: name.slice(0, 100) || "Conversation" }).catch((e: unknown) =>
        // Another handler anchored it first. A message's thread has the message's id.
        (e as { code?: unknown }).code === THREAD_ALREADY_EXISTS ? { id: messageId } : null,
      );
      return t ? { threadId: t.id } : null;
    },
    async postToThread(threadId, content, files, mentionUserIds, opts) {
      const t = await thread(threadId);
      if (!t) return false;
      if (t.archived) await t.setArchived(false).catch(() => {});
      const chunks = splitForDiscord(content, 2000);
      const df = toDiscordFiles(files);
      // Mentions stay locked down by default (parse: []); a caller may opt in EXACTLY the user ids it
      // wants to ping (assignee / participant notifications) — @everyone/@here and stray pings never fire.
      const allow = mentionUserIds?.length ? { users: mentionUserIds, parse: [] as never[] } : { parse: [] as never[] };
      let filesNotUploaded = 0;
      for (let i = 0; i < chunks.length; i++) {
        // Attach files once, on the first chunk, so a long reply doesn't duplicate uploads. The ping
        // rides the first chunk (where the <@id> mention text is).
        const message = {
          content: chunks[i],
          allowedMentions: i === 0 ? allow : { parse: [] },
          // Idempotent retries: same row → same nonce per chunk → Discord returns the existing message.
          ...(opts?.nonce ? { nonce: `${opts.nonce}.${i}`, enforceNonce: true } : {}),
        };
        if (i === 0 && df.length) {
          // A refused upload created no message, so the text goes again without the files, under the same nonce.
          await t.send({ ...message, files: df }).catch(async (e: unknown) => {
            if (!uploadTooLarge(e)) throw e;
            filesNotUploaded = df.length;
            await t.send(message);
          });
        } else {
          await t.send(message);
        }
      }
      if (filesNotUploaded) {
        await t.send({
          content: filesNotUploadedNote(filesNotUploaded),
          allowedMentions: { parse: [] },
          ...(opts?.nonce ? { nonce: `${opts.nonce}.f`, enforceNonce: true } : {}),
        });
      }
      return true;
    },
    async setArchived(threadId, archived) {
      const t = await thread(threadId, true);
      if (!t) return false;
      if (t.archived === archived) return true;
      await t.setArchived(archived);
      return true;
    },
    async applyTags(threadId, tagNames) {
      const t = await thread(threadId, true);
      if (!t || t.parent?.type !== ChannelType.GuildForum) return false;
      const ids = await resolveForumTagIds(t.parent as ForumChannel, tagNames).catch(() => []);
      if (!ids.length) return false;
      // Already exactly these tags → nothing to do. This used to PATCH unconditionally (unarchive, set,
      // re-archive = 3 thread edits) on EVERY sync, i.e. after every relayed message. Discord rate-limits
      // thread edits per channel and discord.js sleeps on the limit, so an active ticket's syncs queued up
      // for minutes and stalled everything waiting on them (duplicate relay posts, missing ✅ marks).
      const current = [...(t.appliedTags ?? [])].sort().join(",");
      if (current === [...ids].sort().join(",")) return true;
      // setAppliedTags on an archived thread 400s — unarchive/rearchive around it.
      const wasArchived = t.archived === true;
      if (wasArchived) await t.setArchived(false).catch(() => {});
      try {
        // PROPAGATE the real failure (e.g. Missing Permissions) — do NOT swallow it here, or the
        // caller thinks the tag applied when Discord refused. Re-archive in finally regardless.
        await t.setAppliedTags(ids);
      } finally {
        if (wasArchived) await t.setArchived(true).catch(() => {});
      }
      return true;
    },
    async forumTagNames(threadId) {
      const t = await thread(threadId);
      if (!t || t.parent?.type !== ChannelType.GuildForum) return [];
      return (t.parent as ForumChannel).availableTags.map((tg) => tg.name);
    },
    async threadArchived(threadId) {
      const t = await thread(threadId);
      return t ? (t.archived ?? false) : null;
    },
    async listForumTags(channelId) {
      const f = await forum(channelId);
      return f ? f.availableTags.map((tg) => tg.name) : [];
    },
    async setLocked(threadId, locked) {
      const t = await thread(threadId, true);
      if (!t) return false;
      if (t.locked === locked) return true;
      await t.setLocked(locked);
      return true;
    },
    async react(threadId, messageId, emoji) {
      // One direct REST call (PUT own reaction). The old path fetched the channel and then the message
      // before reacting — two extra round-trips that queue behind anything else on that channel, which is
      // how the ✅/🆗 confirmation ended up missing. Adding a reaction that's already there is a no-op on
      // Discord's side, so retries are safe. Report the ACTUAL outcome so the relay drainer can retry.
      const put = () => client.rest.put(Routes.channelMessageOwnReaction(threadId, messageId, encodeURIComponent(emoji)));
      try {
        await put();
        return true;
      } catch (e) {
        // 50083: the thread was archived (e.g. a ✅ close archived the post before the confirmation
        // landed). Reacting needs it active — unarchive, react, then put it back.
        if ((e as { code?: number }).code !== 50083) return false;
        const t = await thread(threadId);
        if (!t) return false;
        await t.setArchived(false).catch(() => {});
        try {
          await put();
          return true;
        } catch {
          return false;
        } finally {
          await t.setArchived(true).catch(() => {});
        }
      }
    },
    async memberRoleIds(guildId, userId) {
      const guild = await client.guilds.fetch(guildId).catch(() => null);
      if (!guild) return [];
      const member = await guild.members.fetch(userId).catch(() => null);
      return member ? [...member.roles.cache.keys()] : [];
    },
  };
}

/** Replace Discord's raw mention tokens with human-readable text BEFORE the content is persisted as a
 *  note or a ticket message — otherwise "<@741192238247313488> …" is stored verbatim (and later shown
 *  to agents). Uses the resolved mentions discord.js already attaches to the payload, so there are NO
 *  extra API calls: <@id>/<@!id> → @displayname, <#id> → #channel, <@&id> → @role. An id that isn't in
 *  the payload (uncached) keeps its raw token rather than guessing. */
function resolveMentions(msg: Message): string {
  const text = msg.content ?? "";
  if (!text.includes("<")) return text; // fast path — nothing to resolve
  return text
    .replace(/<@!?(\d+)>/g, (m, id: string) => {
      const name =
        msg.mentions.members?.get(id)?.displayName ??
        msg.mentions.users.get(id)?.globalName ??
        msg.mentions.users.get(id)?.username;
      return name ? `@${name}` : m;
    })
    .replace(/<#(\d+)>/g, (m, id: string) => {
      const ch = msg.mentions.channels.get(id) as { name?: string } | undefined;
      return ch?.name ? `#${ch.name}` : m;
    })
    .replace(/<@&(\d+)>/g, (m, id: string) => {
      const role = msg.mentions.roles.get(id);
      return role ? `@${role.name}` : m;
    });
}

/** Thread taxonomy from a discord.js channel: a thread whose parent is a forum is a forum_post,
 *  any other thread is a text_thread, and a non-thread channel is 'channel' (top-level). */
function threadTaxonomy(channel: unknown): {
  kind: "text_thread" | "forum_post" | "channel";
  threadId: string | null;
  parentId: string | null;
  name: string | null;
} {
  const ch = channel as {
    id?: string;
    parentId?: string | null;
    name?: string | null;
    parent?: { type?: number } | null;
    isThread?: () => boolean;
  };
  const isThread = typeof ch.isThread === "function" ? ch.isThread() : false;
  if (!isThread) return { kind: "channel", threadId: null, parentId: null, name: null };
  const parentIsForum = ch.parent?.type === ChannelType.GuildForum;
  return {
    kind: parentIsForum ? "forum_post" : "text_thread",
    threadId: ch.id ?? null,
    parentId: ch.parentId ?? null,
    name: ch.name ?? null,
  };
}

// ── Phase 5: on-demand slash commands (/ask + /draft) ─────────────────────────
// Registered guild-scoped (instant, unlike ~1h global propagation) at ClientReady + GuildCreate.
// No DISCORD_APPLICATION_ID needed — discord.js derives the application id from the bot token, so
// guild.commands.set() just works once the client is ready.
const SLASH_COMMANDS = [
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask the assistant — it answers from the knowledge base")
    .addStringOption((o) => o.setName("question").setDescription("What do you want to know?").setRequired(true)),
  // Hidden from members without Manage Threads, which server admins can grant to a team role in Integrations.
  // handleDraftCommand still checks that the caller is a teammate.
  new SlashCommandBuilder()
    .setName("draft")
    .setDescription("Draft a private reply you can review, then post to the thread")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageThreads)
    .addStringOption((o) => o.setName("question").setDescription("What should the reply address?").setRequired(true)),
];

// /draft → Post relay: the FULL draft text keyed by the draft interaction id, so the Post button can
// recover it (interaction.message.content is display-truncated to 2000). Bounded (evict oldest past
// 500) so it can't grow unbounded; process-local — fine for the single-replica dev/stage bot.
const draftStore = new Map<string, { ticketId: string; channelId: string; text: string }>();
function stashDraft(token: string, v: { ticketId: string; channelId: string; text: string }): void {
  draftStore.set(token, v);
  if (draftStore.size > 500) {
    const oldest = draftStore.keys().next().value;
    if (oldest) draftStore.delete(oldest);
  }
}

// Command writes are rate-limited, so only the leader registers, once per guild per process.
const commandsRegistered = new Set<string>();

async function registerCommandsForGuild(botId: string, guild: Guild, log: Log): Promise<void> {
  const key = `${botId}:${guild.id}`;
  if (!isDiscordEventLeader() || commandsRegistered.has(key)) return;
  commandsRegistered.add(key);
  try {
    await guild.commands.set(SLASH_COMMANDS);
    await relayPool
      .query("UPDATE discord_links SET commands_registered_at = now() WHERE guild_id = $1", [guild.id])
      .catch(() => {});
    log.info(`discord: slash commands registered for guild ${guild.id}`);
  } catch (err) {
    commandsRegistered.delete(key);
    log.warn({ err }, `discord: command registration failed for guild ${guild.id}`);
  }
}

/** The shared bot decides eligibility when it is configured, otherwise any connected tenant bot does. */
function leaderGatewayDownSince(): number | null {
  if (gatewayDownSince.has("shared")) return gatewayDownSince.get("shared") ?? null;
  const states = [...gatewayDownSince.values()];
  if (states.some((v) => v === null)) return null;
  return states.length ? Math.min(...(states as number[])) : Date.now();
}

function onLeadershipAcquired(log: Log): void {
  for (const [botId, client] of clients) {
    if (!client.isReady()) continue;
    for (const guild of client.guilds.cache.values()) void registerCommandsForGuild(botId, guild, log);
    void backfillBot(botId, log);
  }
}

// The leader records when each bot was last connected, which is where the next backfill starts. A bot's
// heartbeat is paused from a disconnect until its backfill has run, so a reconnect can't move that point forward.
const HEARTBEAT_MS = 30_000;
const heartbeatPaused = new Set<string>();
const backfillsRunning = new Set<string>();

function writeHeartbeats(): void {
  if (!isDiscordEventLeader()) return;
  const ids = [...gatewayDownSince].filter(([id, down]) => down === null && !heartbeatPaused.has(id)).map(([id]) => id);
  void recordSeenConnected(ids).catch(() => {});
}

type GatewayChannel = BackfillChannel<Message> & { raw: GuildTextBasedChannel };

function backfillableChannels(client: Client): GatewayChannel[] {
  const out: GatewayChannel[] = [];
  for (const ch of client.channels.cache.values()) {
    if (ch.isDMBased() || !ch.isTextBased()) continue;
    const raw = ch as GuildTextBasedChannel;
    out.push({
      id: raw.id,
      guildId: raw.guildId,
      isThread: raw.isThread(),
      parentId: raw.isThread() ? raw.parentId : null,
      lastMessageId: raw.lastMessageId,
      fetchAfter: async (after, limit) =>
        [...(await raw.messages.fetch({ after, limit, cache: false })).values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1)),
      raw,
    });
  }
  return out;
}

/** Read back the messages a bot missed since it was last seen connected, then resume its heartbeat.
 *  A retry passes the first attempt's `since`, because the heartbeat may have moved on in between. */
async function backfillBot(botId: string, log: Log, retry?: { since: number | null | undefined; attempt: number }): Promise<void> {
  const client = clients.get(botId);
  if (!client?.isReady() || !isDiscordEventLeader() || backfillsRunning.has(botId)) return;
  backfillsRunning.add(botId);
  heartbeatPaused.add(botId);
  let since: number | null | undefined = retry?.since;
  const retryLater = (delayMs: number) => {
    // An undefined `since` means the heartbeat was never read, so the retry reads it.
    const t = setTimeout(() => void backfillBot(botId, log, { since, attempt: (retry?.attempt ?? 0) + 1 }), delayMs);
    if (typeof t.unref === "function") t.unref();
  };
  try {
    if (since === undefined) since = await lastSeenConnected(botId);
    if (since === null) {
      log.info(`discord: no earlier connection recorded for bot ${botId} - nothing to backfill`);
      heartbeatPaused.delete(botId);
      return;
    }
    const scopes = await loadGuildScopes([...client.guilds.cache.keys()]);
    const { evaluateAutoreply } = await import("./autoreply.js");
    const s = await backfillChannels<Message, GatewayChannel>(backfillableChannels(client), scopes, since, {
      onThreadCreated: async (ch) => {
        if (ch.raw.isThread()) await ingestGatewayThreadCreate(ch.raw);
      },
      onMessage: (m) => ingestGatewayMessage(m, log, { skipAutoreply: true }),
      onTicketBackfilled: async (tenantId, ticketId, messageId) => {
        await evaluateAutoreply(tenantId, ticketId, messageId, { combineUnanswered: true });
      },
      abortOn: (err) => err instanceof RateLimitError,
    });
    log.info(
      `discord: backfill for bot ${botId} covered ${s.gapSeconds}s - read ${s.fetched} of ${s.checked} channel(s), ` +
        `${s.messages} message(s), ${s.failed} channel(s) unreadable, ${s.failedMessages} message(s) failed` +
        (s.truncated ? " - hit the read cap, some messages were not read" : ""),
    );
    if (s.abortedBy instanceof RateLimitError) {
      const delayMs = Math.min(rateLimitWaitMs(s.abortedBy), MAX_TIMER_MS);
      log.warn(`discord: backfill for bot ${botId} stopped on a rate limit - retrying in ${Math.round(delayMs / 1000)}s`);
      retryLater(delayMs);
      return;
    }
    heartbeatPaused.delete(botId);
  } catch (err) {
    const delayMs = loginRetryDelayMs((retry?.attempt ?? 0) + 1, err);
    log.warn({ err }, `discord: backfill for bot ${botId} failed - retrying in ${Math.round(delayMs / 1000)}s`);
    retryLater(delayMs);
  } finally {
    backfillsRunning.delete(botId);
  }
}

/** Best-effort role ids for the invoking member (empty ⇒ the classifier defaults to customer, which
 *  is the right fallback for /ask). interaction.member may be a raw API member, whose roles are an id array. */
function invokerRoleIds(interaction: ChatInputCommandInteraction | ButtonInteraction): string[] {
  const m = interaction.member;
  if (!m || !("roles" in m) || !m.roles) return [];
  if (Array.isArray(m.roles)) return m.roles.map(String);
  if (typeof m.roles === "object" && "cache" in m.roles) {
    return [...(m.roles.cache as Map<string, unknown>).keys()];
  }
  return [];
}

/** editReply, chunked for answers over Discord's 2000-char message cap (ephemeral follow-ups). */
async function editReplyChunked(interaction: ChatInputCommandInteraction, text: string): Promise<void> {
  const chunks = splitForDiscord(text, 2000);
  await interaction.editReply({ content: chunks[0] });
  for (let i = 1; i < chunks.length; i++) {
    await interaction.followUp({ content: chunks[i], flags: MessageFlags.Ephemeral });
  }
}

async function onAsk(interaction: ChatInputCommandInteraction, send: Sender | null, log: Log): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral }); // ack privately within 3s
  if (!interaction.guildId) {
    await interaction.editReply({ content: "Use /ask inside a server channel." });
    return;
  }
  const tax = threadTaxonomy(interaction.channel);
  const channelId = tax.threadId ?? interaction.channelId;
  const res = await handleAskCommand({
    guildId: interaction.guildId,
    channelId,
    parentId: tax.parentId,
    threadKind: tax.kind,
    threadName: tax.name,
    invokerId: interaction.user.id,
    invokerDisplayName: interaction.user.globalName ?? interaction.user.username,
    invokerAvatarUrl: interaction.user.displayAvatarURL(),
    invokerRoleIds: invokerRoleIds(interaction),
    query: interaction.options.getString("question", true),
    interactionId: interaction.id,
  });
  if (res.status === "answered" && res.text) {
    if (res.isPublic) {
      // Post the answer in-channel via the shared sender (chunking + locked-down mentions), ack privately.
      if (send) await send(channelId, res.text);
      await interaction.editReply({ content: send ? "✅ Answered in the channel." : "The assistant is offline right now." });
    } else {
      await editReplyChunked(interaction, res.text);
    }
    return;
  }
  const notice =
    res.status === "held" ? (res.text ?? "A teammate will follow up.")
    : res.status === "not_connected" ? "This channel isn't connected to the assistant."
    : res.status === "empty" ? "Please include a question."
    : "Something went wrong.";
  await interaction.editReply({ content: notice });
}

async function onDraft(interaction: ChatInputCommandInteraction, log: Log): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!interaction.guildId) {
    await interaction.editReply({ content: "Use /draft inside a server channel." });
    return;
  }
  const tax = threadTaxonomy(interaction.channel);
  const channelId = tax.threadId ?? interaction.channelId;
  const res = await handleDraftCommand({
    guildId: interaction.guildId,
    channelId,
    invokerId: interaction.user.id,
    invokerRoleIds: invokerRoleIds(interaction),
    query: interaction.options.getString("question", true),
  });
  if (res.status === "drafted" && res.text && res.ticketId) {
    stashDraft(interaction.id, { ticketId: res.ticketId, channelId, text: res.text });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`postdraft:${interaction.id}`).setLabel("Post to channel").setStyle(ButtonStyle.Primary),
    );
    const preview = res.text.length > 1900 ? `${res.text.slice(0, 1900)}\n…(full text will be posted)` : res.text;
    await interaction.editReply({ content: preview, components: [row] });
    return;
  }
  const notice =
    res.status === "forbidden" ? "Only teammates can use /draft."
    : res.status === "no_ticket" ? "No ticket is linked to this thread yet — reply in the thread first."
    : res.status === "not_connected" ? "This channel isn't connected to the assistant."
    : res.status === "empty" ? "Please include what the reply should address."
    : "Something went wrong.";
  await interaction.editReply({ content: notice });
}

async function onPostDraft(interaction: ButtonInteraction, log: Log): Promise<void> {
  const token = interaction.customId.slice("postdraft:".length);
  const draft = draftStore.get(token);
  if (!draft) {
    await interaction.update({ content: "This draft expired — run /draft again.", components: [] });
    return;
  }
  // Posting does DB and Discord work, which can outlast the 3 s acknowledgement window.
  await interaction.deferUpdate();
  const r = await postDraft({
    guildId: interaction.guildId ?? "",
    channelId: draft.channelId, ticketId: draft.ticketId, text: draft.text, postId: interaction.id,
    invokerId: interaction.user.id, invokerRoleIds: invokerRoleIds(interaction),
  });
  draftStore.delete(token);
  await interaction.editReply({
    content: r.delivered ? "✅ Posted to the channel."
      : r.forbidden ? "Only teammates can post drafts."
      : r.queued ? "Saved on the ticket - posting to the channel is queued and will retry."
      : "Couldn't post — the channel may be disconnected.",
    components: [],
  });
}

// discord.js waits out every 429 before retrying, and a Cloudflare IP ban sends a Retry-After of about an hour.
// Waiting that long stalls every caller behind the request.
// Below the relay outbox's 20 s deliver deadline, so a write that discord.js holds back never outlives it.
const MAX_RATE_LIMIT_WAIT_MS = 15_000;
const LOG_RATE_LIMIT_WAIT_MS = 5_000;

/** How long discord.js would wait. A header-less Cloudflare 429 puts its Retry-After in sublimitTimeout. */
export function rateLimitWaitMs(d: Pick<RateLimitData, "timeToReset" | "retryAfter" | "sublimitTimeout">): number {
  return Math.max(d.timeToReset, d.retryAfter, d.sublimitTimeout);
}

/** True rejects the request with a RateLimitError, false lets discord.js wait. */
export function failFastOnLongRateLimit(d: RateLimitData, log: Log): boolean {
  const waitMs = rateLimitWaitMs(d);
  if (waitMs < LOG_RATE_LIMIT_WAIT_MS) return false;
  if (waitMs <= MAX_RATE_LIMIT_WAIT_MS) {
    log.info(`discord: ${d.method.toUpperCase()} ${d.route} is rate-limited, waiting ${Math.round(waitMs / 1000)}s (global=${d.global}, scope=${d.scope})`);
    return false;
  }
  log.warn(
    `discord: ${d.method.toUpperCase()} ${d.route} is rate-limited for ${Math.round(waitMs / 1000)}s (global=${d.global}, scope=${d.scope}) - failing fast. ` +
      "A wait of about an hour usually means Cloudflare banned the egress IP.",
  );
  return true;
}

/** The patched @discordjs/ws (api/patches) passes `options.agent` to the gateway socket.
 *  discord.js forwards only the `ws` options it knows, so the agent is added to the manager here. */
export function gatewayStrategy(agent: HttpAgent) {
  return (manager: WebSocketManager) => {
    Object.assign(manager.options, { agent });
    return new SimpleShardingStrategy(manager);
  };
}

/** A gateway message, live or backfilled, through the mirror seam or customer ingest.
 *  Returns the ticket a new message landed on, or null when it was dropped, a note, or already stored. */
async function ingestGatewayMessage(
  msg: Message,
  log: Log,
  opts: { skipAutoreply?: boolean } = {},
): Promise<{ tenantId: string; ticketId: string; messageId: string } | null> {
  if (!msg.guildId) return null; // DM — dropped (the seam re-checks; keep the cheap guard here too)
  // §5.10 fetch-on-demand fallback: msg.member can be null (uncached/webhook) OR present with an
  // unpopulated role cache. Fetch UNCONDITIONALLY whenever member is null or its role cache is
  // empty/absent so the Phase-2 role classifier is correct regardless of the lazy path. (A real
  // member's role cache always contains at least @everyone, so size 0 signals an uncached member.)
  let member = msg.member;
  if ((member === null || member.roles.cache.size === 0) && msg.guild) {
    const fetched = await msg.guild.members.fetch(msg.author.id).catch(() => null);
    if (fetched) member = fetched;
  }
  const tax = threadTaxonomy(msg.channel);
  // Resolve <@id>/<#id>/<@&id> tokens to names ONCE, up front, so BOTH seams (mirror note +
  // customer ingest) persist human-readable text instead of raw mention ids.
  const resolvedContent = resolveMentions(msg);
  // Discord CDN attachments (screenshots/files). Built up-front so BOTH seams can persist them —
  // previously this ran AFTER the mirror-seam early-return, so internal notes lost every file.
  const attachments = [...msg.attachments.values()].map((a) => ({
    url: a.url,
    filename: a.name ?? "file",
    contentType: a.contentType ?? "application/octet-stream",
    size: a.size ?? 0,
  }));

  // Ops-mirror seam: a message inside a mirror forum post is team collaboration on the mirrored
  // ticket (note by default, 📤 promotes) — it must NEVER fall through to customer ingest. The
  // handler also swallows bot messages in mirror threads (echo-guard for our own relays).
  const { handleMirrorPostMessage } = await import("./discord-mirror.js");
  const mirrored = await handleMirrorPostMessage({
    guildId: msg.guildId,
    threadId: tax.threadId,
    discordMessageId: msg.id,
    authorId: msg.author.id,
    authorDisplayName: member?.displayName ?? msg.author.globalName ?? msg.author.username,
    content: resolvedContent,
    roleIds: member ? [...member.roles.cache.keys()] : [],
    attachments,
    isBotOrWebhook: msg.author.bot || msg.webhookId != null,
  });
  if (mirrored.handled) return null;

  const embeds = msg.embeds.map((e) => ({ title: e.title, description: e.description, url: e.url }));
  const r = await handleInboundMessage({
    guildId: msg.guildId,
    channelId: tax.threadId ?? msg.channelId,
    authorId: msg.author.id,
    // Other Discord tokens are converted for the inbox only. A mirror note can be promoted back to a Discord customer.
    content: discordTokensToText(resolvedContent),
    discordMessageId: msg.id,
    threadId: tax.threadId,
    parentId: tax.parentId,
    threadKind: tax.kind,
    authorDisplayName: member?.displayName ?? msg.author.globalName ?? msg.author.username,
    authorAvatarUrl: msg.author.displayAvatarURL(),
    attachments,
    embeds,
    threadName: tax.name,
    roleIds: member ? [...member.roles.cache.keys()] : undefined,
    memberIsNull: member === null,
    isBotOrWebhook: msg.author.bot || msg.webhookId != null,
    stickers: [...msg.stickers.values()].map((st) => st.name),
    poll: msg.poll?.question.text ?? null,
    skipAutoreply: opts.skipAutoreply,
  });
  if (!r) {
    log.info(`discord: message ${msg.id} not ingested (unlinked/unbound/dropped)`);
    return null;
  }
  return r.replay ? null : { tenantId: r.tenantId, ticketId: r.ticketId, messageId: r.messageId };
}

/** A new thread, live or backfilled: seats the owner as the customer of a ticket on the thread. */
async function ingestGatewayThreadCreate(thread: ThreadChannel): Promise<void> {
  if (thread.ownerId && thread.ownerId === thread.client.user?.id) return;
  const parentIsForum = thread.parent?.type === ChannelType.GuildForum;
  const owner = thread.ownerId
    ? await thread.guild.members.fetch(thread.ownerId).catch(() => null)
    : null;
  // A bot-owned thread (our VIP thread-per-message anchor) must not pre-seat a ticket with the
  // bot as the customer — the triggering message's ingest already seated it on this thread id.
  if (owner?.user.bot) return;
  await handleThreadCreate({
    guildId: thread.guildId,
    threadId: thread.id,
    parentId: thread.parentId ?? null,
    ownerId: thread.ownerId ?? null,
    name: thread.name ?? null,
    kind: parentIsForum ? "forum_post" : "text_thread",
    ownerDisplayName: owner?.displayName ?? null,
    ownerAvatarUrl: owner?.user.displayAvatarURL() ?? null,
  });
}

/**
 * Start the shared-bot gateway consumer. Guarded on DISCORD_BOT_TOKEN — absent, the
 * Discord channel is simply off (like initNats without a broker). Holds one Gateway
 * connection in the API process; split to a dedicated worker only if sharding forces
 * it. Requires the privileged Message Content intent (enabled in the dev portal).
 *
 * Every listener closure is a THIN DELEGATOR: it computes a plain-object argument and calls the
 * exported handle* in discord.ts — no lifecycle logic here — so the handlers are unit-testable
 * without a live gateway. No new privileged intents are needed (§5.10): ThreadCreate/Update/Delete
 * ride the Guilds intent, MessageUpdate/Delete ride GuildMessages.
 */
function openBot(botId: string, token: string, scope: "shared" | "tenant", tenantId: string | null, log: Log): void {
  void tenantId; // reserved for per-guild outbound routing when the prod multibot gate lands
  const label = scope === "shared" ? "shared bot" : `tenant bot ${botId.slice(0, 8)}`;
  if (!gatewayDownSince.has(botId)) gatewayDownSince.set(botId, Date.now());
  heartbeatPaused.add(botId);
  const egress = discordEgress();
  const client = new Client({
    rest: {
      rejectOnRateLimit: (d) => failFastOnLongRateLimit(d, log),
      ...(egress ? { makeRequest: proxiedMakeRequest(egress.dispatcher) } : {}),
    },
    ...(egress ? { ws: { buildStrategy: gatewayStrategy(egress.gatewayAgent) } } : {}),
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      // Ops-mirror promote-to-reply: 📤 reactions on mirror-post messages (unprivileged intent).
      GatewayIntentBits.GuildMessageReactions,
    ],
    // Reactions on messages sent before this process started arrive as partials — without these the
    // MessageReactionAdd listener never fires for them.
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  });

  const send: Sender = async (channelId, content, opts) => {
    const ch = await client.channels.fetch(channelId);
    if (!(ch && ch.isTextBased() && "send" in ch)) return false;
    // A ticket thread Discord auto-archived after inactivity refuses new messages until it's
    // unarchived — do it first (mirrors postToThread), so an agent reply into a quiet Discord-origin
    // thread doesn't silently fail. Plain text channels aren't threads, so this no-ops for them.
    if ("isThread" in ch && (ch as ThreadChannel).isThread() && (ch as ThreadChannel).archived) {
      await (ch as ThreadChannel).setArchived(false).catch(() => {});
    }
    const post = (ch as { send: (p: unknown) => Promise<unknown> }).send.bind(ch);
    // allowedMentions is ALWAYS locked down: by default nothing pings (parse: []); a channel-post
    // broadcast may opt exactly ONE role in. @everyone/@here and stray user pings can never fire —
    // a broadcast that accidentally mass-pinged a community would be a self-inflicted incident.
    const allowedMentions = opts?.mentionRoleId ? { roles: [opts.mentionRoleId], parse: [] } : { parse: [] };
    const rolePing = opts?.mentionRoleId ? `<@&${opts.mentionRoleId}>` : "";
    const nonce = (i: number) => (opts?.nonce ? { nonce: `${opts.nonce}.${i}`, enforceNonce: true } : {});

    if (opts?.asEmbed) {
      // Embeds don't ping, so the role mention (if any) rides in a lead `content` line. The
      // description caps at 4096; split into as many embeds as needed, title only the first.
      const parts = splitForDiscord(content, 4096);
      for (let i = 0; i < parts.length; i++) {
        await post({
          ...(i === 0 && rolePing ? { content: rolePing } : {}),
          embeds: [{ ...(i === 0 && opts.title ? { title: opts.title.slice(0, 256) } : {}), description: parts[i] }],
          allowedMentions,
          ...nonce(i),
        });
      }
      return;
    }

    // Plain message path (ticket replies + non-embed channel-posts): chunk at 2000, prepend the
    // role ping to the first chunk only.
    const chunks = splitForDiscord(content, 2000);
    for (let i = 0; i < chunks.length; i++) {
      const body = i === 0 && rolePing ? `${rolePing} ${chunks[i]}` : chunks[i];
      await post({ content: body, allowedMentions, ...nonce(i) });
    }
  };
  senders.set(botId, send);
  clients.set(botId, client);
  mirrorTransports.set(botId, buildMirrorTransport(client));

  client.on(Events.MessageCreate, async (msg) => {
    if (!isDiscordEventLeader()) return; // one api process acts on gateway events (see discord-leader.ts)
    try {
      await ingestGatewayMessage(msg, log);
    } catch (err) {
      log.error({ err }, "discord inbound ingest failed");
    }
  });

  client.on(Events.ThreadCreate, async (thread) => {
    if (!isDiscordEventLeader()) return; // one api process acts on gateway events (see discord-leader.ts)
    try {
      await ingestGatewayThreadCreate(thread);
    } catch (err) {
      log.error({ err }, "discord ThreadCreate failed");
    }
  });

  client.on(Events.ThreadUpdate, async (_old, thread) => {
    if (!isDiscordEventLeader()) return; // one api process acts on gateway events (see discord-leader.ts)
    try {
      // Resolve applied forum-tag ids → names — a "Solved/Resolved" tag is a close gesture. archived
      // (manual resolve OR Discord's inactivity auto-archive) and locked also close the intake ticket.
      const parent = thread.parent as { availableTags?: { id: string; name: string }[] } | null;
      const available = parent?.availableTags ?? [];
      const names = (ids: readonly string[] | null | undefined) =>
        (ids ?? []).map((id) => available.find((t) => t.id === id)?.name).filter((n): n is string => Boolean(n));
      // The previous state lets the handler act only on transitions (our own edits echo back here).
      const previous = _old && !_old.partial ? { locked: _old.locked ?? false, archived: _old.archived ?? false, appliedTagNames: names(_old.appliedTags) } : null;
      await handleThreadUpdate(thread.guildId, thread.id, {
        locked: thread.locked ?? false,
        archived: thread.archived ?? false,
        appliedTagNames: names(thread.appliedTags),
      }, previous);
    } catch (err) {
      log.error({ err }, "discord ThreadUpdate failed");
    }
  });

  client.on(Events.ThreadDelete, async (thread) => {
    if (!isDiscordEventLeader()) return; // one api process acts on gateway events (see discord-leader.ts)
    try {
      await handleThreadDelete(thread.guildId, thread.id);
    } catch (err) {
      log.error({ err }, "discord ThreadDelete failed");
    }
  });

  client.on(Events.MessageUpdate, async (_old, msg) => {
    if (!isDiscordEventLeader()) return; // one api process acts on gateway events (see discord-leader.ts)
    try {
      // A partial update has no content, and storing it would blank the message.
      if (!msg.guildId || msg.partial) return;
      await handleMessageUpdate({ guildId: msg.guildId, messageId: msg.id, newContent: resolveMentions(msg) });
    } catch (err) {
      log.error({ err }, "discord MessageUpdate failed");
    }
  });

  client.on(Events.MessageDelete, async (msg) => {
    if (!isDiscordEventLeader()) return; // one api process acts on gateway events (see discord-leader.ts)
    try {
      if (!msg.guildId) return;
      await handleMessageDelete({ guildId: msg.guildId, messageId: msg.id });
    } catch (err) {
      log.error({ err }, "discord MessageDelete failed");
    }
  });

  // Ops-mirror reactions: 📤 promotes a responder's message to a customer reply; any other emoji
  // in the tenant's reaction-triage map (shared with Slack) triages the mirrored ticket in place.
  // Partials are fetched so reactions on pre-restart messages still resolve; non-mirror threads
  // no-op instantly on the ticket_mirror lookup.
  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    if (!isDiscordEventLeader()) return; // one api process acts on gateway events (see discord-leader.ts)
    try {
      if (user.bot) return;
      const full = reaction.partial ? await reaction.fetch().catch(() => null) : reaction;
      if (!full || !full.message.guildId) return;
      const { handleMirrorReaction } = await import("./discord-mirror.js");
      const res = await handleMirrorReaction({
        guildId: full.message.guildId,
        threadId: full.message.channelId,
        discordMessageId: full.message.id,
        reactorId: user.id,
        emoji: full.emoji.name ?? "",
      });
      if (res.reason === "not_mirror") {
        // Not an ops-mirror post — a close-mapped reaction (✅) by a marked teammate on a Discord-native
        // (intake) support thread resolves that ticket. No-op for everything else.
        const { handleIntakeReaction } = await import("./discord.js");
        const ir = await handleIntakeReaction({
          guildId: full.message.guildId,
          threadId: full.message.channelId,
          reactorId: user.id,
          emoji: full.emoji.name ?? "",
        });
        if (ir.closed) log.info(`discord: intake thread ${full.message.channelId} closed via reaction`);
        return;
      }
      if (res.promoted) log.info(`discord-mirror: message ${full.message.id} promoted to reply`);
      else if (res.action && !res.reason) log.info(`discord-mirror: reaction triage '${res.action}' applied`);
      else if (res.reason && res.reason !== "not_mirror" && res.reason !== "unmapped_emoji")
        log.info(`discord-mirror: reaction refused (${res.reason})`);
    } catch (err) {
      log.error({ err }, "discord-mirror reaction failed");
    }
  });

  // Phase 5: route slash-command + button interactions to the on-demand handlers.
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!isDiscordEventLeader()) return; // one api process acts on gateway events (see discord-leader.ts)
    const what = interaction.isChatInputCommand() ? `/${interaction.commandName}` : interaction.isButton() ? `button ${interaction.customId.split(":")[0]}` : `type ${interaction.type}`;
    log.info(`discord: interaction ${what} from user ${interaction.user.id} in guild ${interaction.guildId ?? "-"} (${label})`);
    try {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === "ask") await onAsk(interaction, send, log);
        else if (interaction.commandName === "draft") await onDraft(interaction, log);
      } else if (interaction.isButton() && interaction.customId.startsWith("postdraft:")) {
        await onPostDraft(interaction, log);
      }
    } catch (err) {
      log.error({ err }, "discord interaction failed");
    }
  });

  // Register the guild-scoped slash commands: for every guild present at ready, and any joined later.
  client.on(Events.GuildCreate, (guild) => void registerCommandsForGuild(botId, guild, log));

  client.once(Events.ClientReady, async (c) => {
    loginAttempts.delete(botId);
    log.info(`discord: connected as ${c.user.tag} (${label})`);
    for (const guild of c.guilds.cache.values()) await registerCommandsForGuild(botId, guild, log);
    if (scope === "tenant") await markBotReady(botId, c.guilds.cache.size);
  });

  // Connection lifecycle. Without these logs a deaf bot looks the same as a quiet one.
  const markConnected = () => {
    gatewayDownSince.set(botId, null);
    probeDiscordLeaderNow();
  };
  const markDisconnected = () => {
    if (gatewayDownSince.get(botId) === null) gatewayDownSince.set(botId, Date.now());
    heartbeatPaused.add(botId);
  };
  client.on(Events.ShardReady, (shardId, unavailable) => {
    log.info(`discord: ${label} gateway session ready (shard ${shardId}${unavailable?.size ? `, ${unavailable.size} guild(s) unavailable` : ""})`);
    markConnected();
    // A new session gets no replay of what happened while it was down. On a first session the client is
    // ready only after this event.
    const backfill = () => {
      if (isDiscordEventLeader()) void backfillBot(botId, log);
    };
    if (client.isReady()) backfill();
    else client.once(Events.ClientReady, backfill);
  });
  client.on(Events.ShardResume, (shardId, replayed) => {
    log.info(`discord: ${label} gateway resumed (shard ${shardId}, ${replayed} event(s) replayed)`);
    markConnected();
    heartbeatPaused.delete(botId);
  });
  client.on(Events.ShardReconnecting, (shardId) => {
    log.warn(`discord: ${label} gateway reconnecting (shard ${shardId})`);
    markDisconnected();
  });
  client.on(Events.ShardDisconnect, (event, shardId) => {
    log.warn(`discord: ${label} gateway disconnected and won't reconnect (shard ${shardId}, close code ${event.code})`);
    markDisconnected();
    if (scope === "tenant") void markBotDisconnect(botId);
  });
  client.on(Events.ShardError, (err, shardId) => log.warn({ err }, `discord: ${label} gateway error (shard ${shardId})`));
  client.login(token).catch((err: unknown) => {
    // A tenant bot with a revoked token is disabled. The shared bot's token is operator-managed, so it keeps retrying.
    if (scope === "tenant" && isInvalidToken(err)) {
      log.error({ err }, `discord login failed (tenant ${botId}): invalid token - disabling the bot`);
      void quarantineBot(botId, "login_failed");
      return;
    }
    const attempt = (loginAttempts.get(botId) ?? 0) + 1;
    loginAttempts.set(botId, attempt);
    const delayMs = loginRetryDelayMs(attempt, err);
    log.error({ err }, `discord login failed (${scope} ${botId}) - retrying in ${Math.round(delayMs / 1000)}s`);
    // login() destroyed this client, so the retry opens a fresh one.
    const t = setTimeout(() => openBot(botId, token, scope, tenantId, log), delayMs);
    if (typeof t.unref === "function") t.unref();
  });
}

// Exiting or retrying at once after a failed login turns into a tight request loop against a banned IP.
const LOGIN_RETRY_MIN_MS = 30_000;
const LOGIN_RETRY_MAX_MS = 10 * 60_000;
const MAX_TIMER_MS = 60 * 60_000;
const loginAttempts = new Map<string, number>();

function isInvalidToken(err: unknown): boolean {
  const e = err as { code?: unknown; status?: unknown } | null;
  return e?.code === "TokenInvalid" || e?.status === 401;
}

/** 30 s doubling to 10 min, or longer when Discord's rate limit says so. */
export function loginRetryDelayMs(attempt: number, err: unknown): number {
  const backoff = Math.min(LOGIN_RETRY_MIN_MS * 2 ** (attempt - 1), LOGIN_RETRY_MAX_MS);
  const limited = err instanceof RateLimitError ? rateLimitWaitMs(err) : 0;
  return Math.min(Math.max(backoff, limited), MAX_TIMER_MS);
}

/**
 * Start the Discord gateway (Phase 6 manager). Opens the SHARED bot (DISCORD_BOT_TOKEN) exactly as
 * before, then — ONLY when the prod multibot gate DISCORD_MULTIBOT_ENABLED=1 is set — opens each
 * registered, enabled per-tenant BYO bot. On dev/stage the gate is OFF, so tenant bots stay
 * registered but dormant: a customer's live bot is never opened (double-consumed) from a non-prod
 * replica (§13 prod-gate). The shared-bot path is untouched, so single-bot behaviour is identical.
 */
export function startDiscord(log: Log): void {
  const token = process.env.DISCORD_BOT_TOKEN;
  const egress = discordEgress();
  log.info(egress ? `discord: traffic goes through the proxy ${egress.label}` : "discord: traffic goes direct (DISCORD_PROXY_URL unset)");
  // Every replica logs in (outbound REST needs the client), but only the elected leader acts on gateway
  // events — otherwise each event is handled once per replica.
  if (token || process.env.DISCORD_MULTIBOT_ENABLED === "1") {
    startDiscordLeaderElection({ log, gatewayDownSince: leaderGatewayDownSince, onAcquired: () => onLeadershipAcquired(log) });
    const t = setInterval(writeHeartbeats, HEARTBEAT_MS);
    if (typeof t.unref === "function") t.unref();
  }
  if (token) openBot("shared", token, "shared", null, log);
  else log.warn("DISCORD_BOT_TOKEN not set — shared Discord bot disabled");

  if (process.env.DISCORD_MULTIBOT_ENABLED === "1") {
    void listStartableTenantBots()
      .then((bots) => {
        for (const b of bots) openBot(b.botId, b.token, "tenant", b.tenantId, log);
        log.info(`discord: multibot gate ON — opened ${bots.length} tenant bot(s)`);
      })
      .catch((err) => log.error({ err }, "discord: failed to load tenant bots"));
  } else {
    void countStartableTenantBots()
      .then((n) => {
        if (n > 0) log.info(`discord: ${n} tenant bot(s) registered — dormant (multibot gate off on this replica)`);
      })
      .catch(() => {});
  }
}
