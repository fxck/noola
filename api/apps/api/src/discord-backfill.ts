// Backfill of Discord messages created while this process wasn't receiving gateway events: before it became the
// gateway-event leader, or while its session was down and couldn't be resumed. Discord replays nothing to a new
// session, so these messages are read back over REST and handled like live ones.
//
// Reads stay cheap. A message id encodes its creation time, and discord.js caches every channel's and active
// thread's lastMessageId, so a channel with no message since the gap started is skipped without a request.
import { relayPool } from "@repo/db";

/** The parts of a discord.js channel or thread that a backfill needs. */
export interface BackfillChannel<M extends { id: string }> {
  id: string;
  guildId: string;
  isThread: boolean;
  /** The channel a thread hangs under. */
  parentId: string | null;
  lastMessageId: string | null;
  /** Messages newer than `afterId`, oldest first, at most `limit`. */
  fetchAfter(afterId: string, limit: number): Promise<M[]>;
}

export interface BackfillHandlers<M extends { id: string }, C> {
  /** A thread created during the gap, handled like a live ThreadCreate. */
  onThreadCreated(thread: C): Promise<void>;
  /** One message, handled like a live MessageCreate without the autoreply. Returns the ticket it landed on. */
  onMessage(msg: M): Promise<{ tenantId: string; ticketId: string; messageId: string } | null>;
  /** Called once per ticket that got new messages, with the newest of them, after every channel was read. */
  onTicketBackfilled(tenantId: string, ticketId: string, messageId: string): Promise<void>;
  /** True stops the whole run, e.g. on a rate limit, where every further read would fail too. */
  abortOn(err: unknown): boolean;
}

/** Tickets that a backfill read messages for but didn't hand on, by the channel that still needs reading. */
export type HeldBack = Map<string, Map<string, { tenantId: string; messageId: string }>>;

export interface BackfillSummary {
  gapSeconds: number;
  checked: number;
  fetched: number;
  messages: number;
  /** Channels that couldn't be read, e.g. for missing access. */
  failed: number;
  /** Messages that were read but failed to process. */
  failedMessages: number;
  truncated: boolean;
  /** The error that stopped the run early. */
  abortedBy?: unknown;
  /** After an abort, the tickets for the retry to hand on once their channel is read to the end. */
  heldBack: HeldBack;
}

const DISCORD_EPOCH = 1_420_070_400_000n;
const PAGE_SIZE = 100;
const MAX_PAGES_PER_CHANNEL = 5;
const MAX_CHANNELS_PER_RUN = 200;
// A longer outage is backfilled only for its last week.
const MAX_GAP_MS = 7 * 24 * 60 * 60_000;
// A dead socket is noticed only after a missed heartbeat ack, up to about 80 s, and the leader keeps writing
// its heartbeat meanwhile. The margin costs no reads when nothing happened.
const GAP_MARGIN_MS = 120_000;

export function snowflakeAt(ms: number): string {
  return ((BigInt(Math.max(0, Math.floor(ms))) - DISCORD_EPOCH) << 22n).toString();
}

function newerThan(id: string | null, than: string): boolean {
  return !!id && BigInt(id) > BigInt(than);
}

/** Which channels a guild's bindings ingest. `all` when the guild has no bindings and every channel is monitored. */
export interface GuildScope {
  all: boolean;
  /** Bound channels and mirror forums, whose threads are ingested. */
  threadParents: Set<string>;
  /** Bound channels whose top-level messages are ingested (VIP, or require_thread off). */
  topLevel: Set<string>;
}

export async function loadGuildScopes(guildIds: string[]): Promise<Map<string, GuildScope>> {
  const scopes = new Map<string, GuildScope>();
  if (!guildIds.length) return scopes;
  const links = await relayPool.query<{ guild_id: string }>("SELECT guild_id FROM discord_links WHERE guild_id = ANY($1::text[])", [guildIds]);
  for (const l of links.rows) scopes.set(l.guild_id, { all: true, threadParents: new Set(), topLevel: new Set() });
  const bindings = await relayPool.query<{ guild_id: string; channel_id: string; mode: string; require_thread: boolean; thread_per_message: boolean }>(
    "SELECT guild_id, channel_id, mode, require_thread, thread_per_message FROM discord_channel_bindings WHERE guild_id = ANY($1::text[])",
    [guildIds],
  );
  for (const b of bindings.rows) {
    const s = scopes.get(b.guild_id);
    if (!s) continue;
    s.all = false;
    if (b.mode === "off") continue;
    s.threadParents.add(b.channel_id);
    if (b.thread_per_message || !b.require_thread) s.topLevel.add(b.channel_id);
  }
  const forums = await relayPool.query<{ guild_id: string; forum_channel_id: string }>(
    "SELECT guild_id, forum_channel_id FROM discord_mirror_bindings WHERE guild_id = ANY($1::text[]) AND enabled",
    [guildIds],
  );
  for (const f of forums.rows) scopes.get(f.guild_id)?.threadParents.add(f.forum_channel_id);
  return scopes;
}

/** The channels with messages newer than `gapStartId`, in a scope, with threads created during the gap flagged. */
export function planBackfill<M extends { id: string }, C extends BackfillChannel<M>>(
  channels: C[],
  scopes: Map<string, GuildScope>,
  gapStartId: string,
): { channel: C; createdInGap: boolean }[] {
  const plan: { channel: C; createdInGap: boolean }[] = [];
  for (const ch of channels) {
    const scope = scopes.get(ch.guildId);
    if (!scope || !newerThan(ch.lastMessageId, gapStartId)) continue;
    const inScope = ch.isThread
      ? scope.all || (!!ch.parentId && scope.threadParents.has(ch.parentId))
      : !scope.all && scope.topLevel.has(ch.id);
    if (inScope) plan.push({ channel: ch, createdInGap: ch.isThread && newerThan(ch.id, gapStartId) });
  }
  return plan;
}

/**
 * Backfill one bot's channels since `gapStartMs`. Channels are read one at a time, a thread created in the gap
 * is seated before its messages, and each ticket that got messages is handed to `onTicketBackfilled` once.
 * `carried` is the `heldBack` of an aborted run. Its messages are replays now, so they wouldn't hand the ticket on again.
 */
export async function backfillChannels<M extends { id: string }, C extends BackfillChannel<M>>(
  channels: C[],
  scopes: Map<string, GuildScope>,
  gapStartMs: number,
  handlers: BackfillHandlers<M, C>,
  now = Date.now(),
  carried: HeldBack = new Map(),
): Promise<BackfillSummary> {
  const startMs = Math.max(gapStartMs - GAP_MARGIN_MS, now - MAX_GAP_MS);
  const gapStartId = snowflakeAt(startMs);
  const plan = planBackfill(channels, scopes, gapStartId);
  const summary: BackfillSummary = {
    gapSeconds: Math.round((now - startMs) / 1000), checked: channels.length, fetched: 0, messages: 0, failed: 0, failedMessages: 0,
    truncated: plan.length > MAX_CHANNELS_PER_RUN,
    heldBack: new Map(),
  };
  // Per run, not per channel: a VIP ticket spans its top-level channel and its thread, and gets one autoreply.
  const newest = new Map<string, { tenantId: string; messageId: string }>();

  const toRead = plan.slice(0, MAX_CHANNELS_PER_RUN);
  for (const [i, { channel, createdInGap }] of toRead.entries()) {
    summary.fetched++;
    const touched = new Map<string, { tenantId: string; messageId: string }>(carried.get(channel.id));
    try {
      if (createdInGap) await handlers.onThreadCreated(channel);
      let after = gapStartId;
      for (let page = 0; page < MAX_PAGES_PER_CHANNEL; page++) {
        const batch = await channel.fetchAfter(after, PAGE_SIZE);
        for (const msg of batch) {
          summary.messages++;
          try {
            const landed = await handlers.onMessage(msg);
            if (landed) touched.set(landed.ticketId, { tenantId: landed.tenantId, messageId: landed.messageId });
          } catch (err) {
            if (handlers.abortOn(err)) throw err;
            summary.failedMessages++;
          }
        }
        if (batch.length < PAGE_SIZE) break;
        after = batch[batch.length - 1].id;
        if (page === MAX_PAGES_PER_CHANNEL - 1) summary.truncated = true;
      }
    } catch (err) {
      summary.failed++;
      if (handlers.abortOn(err)) {
        summary.abortedBy = err;
        // The retry reads the rest of this channel and hands these tickets on with all their messages.
        if (touched.size) summary.heldBack.set(channel.id, touched);
        for (const { channel: later } of toRead.slice(i + 1)) {
          const c = carried.get(later.id);
          if (c) summary.heldBack.set(later.id, c);
        }
        break;
      }
    }
    for (const [ticketId, n] of touched) newest.set(ticketId, n);
  }
  // A carried channel that is no longer planned, e.g. a deleted thread, can't be read to the end, so its tickets go on now.
  const planned = new Set(toRead.map((p) => p.channel.id));
  for (const [channelId, tickets] of carried) {
    if (planned.has(channelId)) continue;
    for (const [ticketId, n] of tickets) if (!newest.has(ticketId)) newest.set(ticketId, n);
  }
  // A ticket still held back for any channel waits for the retry, even if another channel was read to the end.
  for (const tickets of summary.heldBack.values()) for (const ticketId of tickets.keys()) newest.delete(ticketId);
  for (const [ticketId, n] of newest) await handlers.onTicketBackfilled(n.tenantId, ticketId, n.messageId).catch(() => {});
  return summary;
}

/** When the bot's gateway was last seen connected on the leader, or null when it never was. */
export async function lastSeenConnected(botId: string): Promise<number | null> {
  const r = await relayPool.query<{ seen_at: Date }>("SELECT seen_at FROM discord_gateway_heartbeat WHERE bot_id = $1", [botId]);
  return r.rowCount ? r.rows[0].seen_at.getTime() : null;
}

export async function recordSeenConnected(botIds: string[]): Promise<void> {
  if (!botIds.length) return;
  await relayPool.query(
    `INSERT INTO discord_gateway_heartbeat (bot_id, seen_at) SELECT unnest($1::text[]), now()
     ON CONFLICT (bot_id) DO UPDATE SET seen_at = EXCLUDED.seen_at`,
    [botIds],
  );
}
