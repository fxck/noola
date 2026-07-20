import {
  Client, GatewayIntentBits, Events, ChannelType, Partials,
  SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
  type ChatInputCommandInteraction, type ButtonInteraction, type Guild,
  type ForumChannel, type ThreadChannel,
} from "discord.js";
import { relayPool } from "@repo/db";
import { splitForDiscord } from "./channels/format.js";
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

/** The live outbound sender for a bot ('shared' by default), or null when it's disabled/unconnected. */
export function getDiscordSender(botId = "shared"): Sender | null {
  return senders.get(botId) ?? senders.get("shared") ?? null;
}

// ── Forum ops-mirror transport (discord-mirror.ts) ─────────────────────────────
// The mirror engine's Discord surface: forum-post CRUD, tag sync, archive, reactions, role reads.
// Same registry shape as senders; tests inject a mock via setMirrorTransportForTests.
export interface MirrorTransport {
  /** Forum channels the bot can see in a guild (Settings picker). */
  listForums(guildId: string): Promise<{ id: string; name: string }[]>;
  /** Roles in a guild (responder-role picker). */
  listRoles(guildId: string): Promise<{ id: string; name: string }[]>;
  /** Text channels in a guild (VIP customer-channel picker). */
  listTextChannels(guildId: string): Promise<{ id: string; name: string }[]>;
  /** Create one forum post; ensures the tag names exist on the forum (best-effort) and applies them. */
  createForumPost(forumChannelId: string, name: string, content: string, tagNames: string[]): Promise<{ threadId: string } | null>;
  /** Anchor a thread on an existing channel message (VIP thread-per-message bindings, D5). */
  createMessageThread(channelId: string, messageId: string, name: string): Promise<{ threadId: string } | null>;
  postToThread(threadId: string, content: string): Promise<boolean>;
  setArchived(threadId: string, archived: boolean): Promise<boolean>;
  applyTags(threadId: string, tagNames: string[]): Promise<boolean>;
  /** Parent-forum tag names for a thread — used to detect an existing "Solved/Resolved" tag. */
  forumTagNames?(threadId: string): Promise<string[]>;
  /** Available tag names on a FORUM channel (Settings picker for the per-binding close tag). */
  listForumTags?(channelId: string): Promise<string[]>;
  /** Lock a thread (per-binding close action). Optional, like forumTagNames. */
  setLocked?(threadId: string, locked: boolean): Promise<boolean>;
  react(threadId: string, messageId: string, emoji: string): Promise<boolean>;
  memberRoleIds(guildId: string, userId: string): Promise<string[]>;
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

function buildMirrorTransport(client: Client): MirrorTransport {
  const forum = async (id: string): Promise<ForumChannel | null> => {
    const ch = await client.channels.fetch(id).catch(() => null);
    return ch?.type === ChannelType.GuildForum ? (ch as ForumChannel) : null;
  };
  const thread = async (id: string): Promise<ThreadChannel | null> => {
    const ch = await client.channels.fetch(id).catch(() => null);
    return ch && "isThread" in ch && (ch as ThreadChannel).isThread() ? (ch as ThreadChannel) : null;
  };
  return {
    async listForums(guildId) {
      const guild = await client.guilds.fetch(guildId).catch(() => null);
      if (!guild) return [];
      const channels = await guild.channels.fetch().catch(() => null);
      if (!channels) return [];
      return [...channels.values()]
        .filter((c) => c?.type === ChannelType.GuildForum)
        .map((c) => ({ id: c!.id, name: c!.name }));
    },
    async listRoles(guildId) {
      const guild = await client.guilds.fetch(guildId).catch(() => null);
      if (!guild) return [];
      const roles = await guild.roles.fetch().catch(() => null);
      if (!roles) return [];
      return [...roles.values()].filter((r) => r.name !== "@everyone").map((r) => ({ id: r.id, name: r.name }));
    },
    async listTextChannels(guildId) {
      const guild = await client.guilds.fetch(guildId).catch(() => null);
      if (!guild) return [];
      const channels = await guild.channels.fetch().catch(() => null);
      if (!channels) return [];
      return [...channels.values()]
        .filter((c) => c?.type === ChannelType.GuildText)
        .map((c) => ({ id: c!.id, name: c!.name }));
    },
    async createForumPost(forumChannelId, name, content, tagNames) {
      const f = await forum(forumChannelId);
      if (!f) return null;
      const appliedTags = await resolveForumTagIds(f, tagNames).catch(() => []);
      const chunks = splitForDiscord(content, 2000);
      const created = await f.threads.create({
        name: name.slice(0, 100) || "Support ticket",
        message: { content: chunks[0], allowedMentions: { parse: [] } },
        appliedTags,
      }).catch(() => null);
      if (!created) return null;
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
      const t = await msg.startThread({ name: name.slice(0, 100) || "Conversation" }).catch(() => null);
      return t ? { threadId: t.id } : null;
    },
    async postToThread(threadId, content) {
      const t = await thread(threadId);
      if (!t) return false;
      if (t.archived) await t.setArchived(false).catch(() => {});
      for (const chunk of splitForDiscord(content, 2000)) {
        await t.send({ content: chunk, allowedMentions: { parse: [] } });
      }
      return true;
    },
    async setArchived(threadId, archived) {
      const t = await thread(threadId);
      if (!t) return false;
      if (t.archived === archived) return true;
      await t.setArchived(archived);
      return true;
    },
    async applyTags(threadId, tagNames) {
      const t = await thread(threadId);
      if (!t || t.parent?.type !== ChannelType.GuildForum) return false;
      const ids = await resolveForumTagIds(t.parent as ForumChannel, tagNames).catch(() => []);
      if (!ids.length) return false;
      // setAppliedTags on an archived thread 400s — unarchive/rearchive around it.
      const wasArchived = t.archived === true;
      if (wasArchived) await t.setArchived(false).catch(() => {});
      await t.setAppliedTags(ids).catch(() => {});
      if (wasArchived) await t.setArchived(true).catch(() => {});
      return true;
    },
    async forumTagNames(threadId) {
      const t = await thread(threadId);
      if (!t || t.parent?.type !== ChannelType.GuildForum) return [];
      return (t.parent as ForumChannel).availableTags.map((tg) => tg.name);
    },
    async listForumTags(channelId) {
      const f = await forum(channelId);
      return f ? f.availableTags.map((tg) => tg.name) : [];
    },
    async setLocked(threadId, locked) {
      const t = await thread(threadId);
      if (!t) return false;
      if (t.locked === locked) return true;
      await t.setLocked(locked);
      return true;
    },
    async react(threadId, messageId, emoji) {
      const t = await thread(threadId);
      if (!t) return false;
      const msg = await t.messages.fetch(messageId).catch(() => null);
      if (!msg) return false;
      await msg.react(emoji).catch(() => false);
      return true;
    },
    async memberRoleIds(guildId, userId) {
      const guild = await client.guilds.fetch(guildId).catch(() => null);
      if (!guild) return [];
      const member = await guild.members.fetch(userId).catch(() => null);
      return member ? [...member.roles.cache.keys()] : [];
    },
  };
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
  new SlashCommandBuilder()
    .setName("draft")
    .setDescription("Draft a private reply you can review, then post to the thread")
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

async function registerCommandsForGuild(guild: Guild, log: Log): Promise<void> {
  try {
    await guild.commands.set(SLASH_COMMANDS);
    await relayPool
      .query("UPDATE discord_links SET commands_registered_at = now() WHERE guild_id = $1", [guild.id])
      .catch(() => {});
    log.info(`discord: slash commands registered for guild ${guild.id}`);
  } catch (err) {
    log.warn({ err }, `discord: command registration failed for guild ${guild.id}`);
  }
}

/** Best-effort role ids for the invoking member (empty ⇒ the classifier defaults to customer, which
 *  is the right fallback for /ask). interaction.member may be a raw API member without a role cache. */
function invokerRoleIds(interaction: ChatInputCommandInteraction): string[] {
  const m = interaction.member;
  if (m && "roles" in m && m.roles && typeof m.roles === "object" && "cache" in m.roles) {
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
    res.status === "no_ticket" ? "No ticket is linked to this thread yet — reply in the thread first."
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
  const r = await postDraft({
    guildId: interaction.guildId ?? "",
    channelId: draft.channelId, ticketId: draft.ticketId, text: draft.text, postId: interaction.id,
  });
  draftStore.delete(token);
  await interaction.update({
    content: r.delivered ? "✅ Posted to the channel." : "Couldn't post — the channel may be disconnected.",
    components: [],
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
  const client = new Client({
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
    if (!(ch && ch.isTextBased() && "send" in ch)) return;
    const post = (ch as { send: (p: unknown) => Promise<unknown> }).send.bind(ch);
    // allowedMentions is ALWAYS locked down: by default nothing pings (parse: []); a channel-post
    // broadcast may opt exactly ONE role in. @everyone/@here and stray user pings can never fire —
    // a broadcast that accidentally mass-pinged a community would be a self-inflicted incident.
    const allowedMentions = opts?.mentionRoleId ? { roles: [opts.mentionRoleId], parse: [] } : { parse: [] };
    const rolePing = opts?.mentionRoleId ? `<@&${opts.mentionRoleId}>` : "";

    if (opts?.asEmbed) {
      // Embeds don't ping, so the role mention (if any) rides in a lead `content` line. The
      // description caps at 4096; split into as many embeds as needed, title only the first.
      const parts = splitForDiscord(content, 4096);
      for (let i = 0; i < parts.length; i++) {
        await post({
          ...(i === 0 && rolePing ? { content: rolePing } : {}),
          embeds: [{ ...(i === 0 && opts.title ? { title: opts.title.slice(0, 256) } : {}), description: parts[i] }],
          allowedMentions,
        });
      }
      return;
    }

    // Plain message path (ticket replies + non-embed channel-posts): chunk at 2000, prepend the
    // role ping to the first chunk only.
    const chunks = splitForDiscord(content, 2000);
    for (let i = 0; i < chunks.length; i++) {
      const body = i === 0 && rolePing ? `${rolePing} ${chunks[i]}` : chunks[i];
      await post({ content: body, allowedMentions });
    }
  };
  senders.set(botId, send);
  mirrorTransports.set(botId, buildMirrorTransport(client));

  client.on(Events.MessageCreate, async (msg) => {
    if (!msg.guildId) return; // DM — dropped (the seam re-checks; keep the cheap guard here too)
    try {
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
        content: msg.content ?? "",
        roleIds: member ? [...member.roles.cache.keys()] : [],
        isBotOrWebhook: msg.author.bot || msg.webhookId != null,
      });
      if (mirrored.handled) return;

      const attachments = [...msg.attachments.values()].map((a) => ({
        url: a.url,
        filename: a.name ?? "file",
        contentType: a.contentType ?? "application/octet-stream",
        size: a.size ?? 0,
      }));
      const embeds = msg.embeds.map((e) => ({ title: e.title, description: e.description, url: e.url }));
      const r = await handleInboundMessage({
        guildId: msg.guildId,
        channelId: tax.threadId ?? msg.channelId,
        authorId: msg.author.id,
        content: msg.content ?? "",
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
      });
      if (!r) log.info(`discord: message ${msg.id} not ingested (unlinked/unbound/dropped)`);
    } catch (err) {
      log.error({ err }, "discord inbound ingest failed");
    }
  });

  client.on(Events.ThreadCreate, async (thread) => {
    try {
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
    } catch (err) {
      log.error({ err }, "discord ThreadCreate failed");
    }
  });

  client.on(Events.ThreadUpdate, async (_old, thread) => {
    try {
      // Resolve applied forum-tag ids → names — a "Solved/Resolved" tag is a close gesture. archived
      // (manual resolve OR Discord's inactivity auto-archive) and locked also close the intake ticket.
      const parent = thread.parent as { availableTags?: { id: string; name: string }[] } | null;
      const available = parent?.availableTags ?? [];
      const appliedTagNames = (thread.appliedTags ?? [])
        .map((id) => available.find((t) => t.id === id)?.name)
        .filter((n): n is string => Boolean(n));
      await handleThreadUpdate(thread.guildId, thread.id, {
        locked: thread.locked ?? false,
        archived: thread.archived ?? false,
        appliedTagNames,
      });
    } catch (err) {
      log.error({ err }, "discord ThreadUpdate failed");
    }
  });

  client.on(Events.ThreadDelete, async (thread) => {
    try {
      await handleThreadDelete(thread.guildId, thread.id);
    } catch (err) {
      log.error({ err }, "discord ThreadDelete failed");
    }
  });

  client.on(Events.MessageUpdate, async (_old, msg) => {
    try {
      if (!msg.guildId) return;
      await handleMessageUpdate({ guildId: msg.guildId, messageId: msg.id, newContent: msg.content ?? "" });
    } catch (err) {
      log.error({ err }, "discord MessageUpdate failed");
    }
  });

  client.on(Events.MessageDelete, async (msg) => {
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
  client.on(Events.GuildCreate, (guild) => void registerCommandsForGuild(guild, log));

  client.once(Events.ClientReady, async (c) => {
    const label = scope === "shared" ? "shared bot" : `tenant bot ${botId.slice(0, 8)}`;
    log.info(`discord: connected as ${c.user.tag} (${label})`);
    for (const guild of c.guilds.cache.values()) await registerCommandsForGuild(guild, log);
    if (scope === "tenant") await markBotReady(botId, c.guilds.cache.size);
  });
  if (scope === "tenant") client.on(Events.ShardDisconnect, () => void markBotDisconnect(botId));
  client.login(token).catch((err: unknown) => {
    log.error({ err }, `discord login failed (${scope} ${botId})`);
    // A per-tenant bot with a bad/revoked token is quarantined so the manager stops retrying it; the
    // shared bot just logs (its token is operator-managed).
    if (scope === "tenant") void quarantineBot(botId, "login_failed");
  });
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
