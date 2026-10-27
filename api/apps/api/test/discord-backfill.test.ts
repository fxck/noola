import pg from "pg";
import { appPool, relayPool, withTenant } from "@repo/db";
import {
  backfillChannels, lastSeenConnected, loadGuildScopes, planBackfill, recordSeenConnected, snowflakeAt,
  type BackfillChannel, type GuildScope,
} from "../src/discord-backfill.js";
import { unansweredCustomerText } from "../src/autoreply.js";
import { handleInboundMessage, linkGuild } from "../src/discord.js";
import { setMirrorTransportForTests } from "../src/discord-mirror.js";
import type { MirrorTransport } from "../src/discord-gateway.js";
import { ingestInbound } from "../src/ingest.js";

// Discord backfill (discord-backfill.ts): which channels are read after a gap, how they are paged, and what is
// handed on. The first half is pure, the second runs against the dev DB.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const GUILD = "BFTEST-guild";

let failures = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${got !== undefined ? ` — got: ${JSON.stringify(got)}` : ""}`); }
}

type Msg = { id: string; ticketId?: string };
type Ch = BackfillChannel<Msg> & { fetches: string[] };

const NOW = Date.parse("2026-10-25T20:00:00Z");
const GAP_START = NOW - 10 * 60_000;
const at = (ms: number) => snowflakeAt(ms);

function channel(over: Partial<Ch> & { id: string }, messages: Msg[] = []): Ch {
  const ch: Ch = {
    guildId: "g1", isThread: true, parentId: "forum", lastMessageId: null, fetches: [],
    async fetchAfter(after, limit) {
      ch.fetches.push(after);
      return messages.filter((m) => BigInt(m.id) > BigInt(after)).slice(0, limit);
    },
    ...over,
  };
  return ch;
}

const scope = (s: Partial<GuildScope>): Map<string, GuildScope> =>
  new Map([["g1", { all: false, threadParents: new Set(["forum"]), topLevel: new Set(["vip"]), ...s }]]);

async function pure() {
  const t = NOW - 5 * 60_000;
  check("a snowflake encodes its time", Number((BigInt(at(t)) >> 22n) + 1_420_070_400_000n) === t);

  const gapId = at(GAP_START);
  const quiet = channel({ id: at(NOW - 86_400_000), lastMessageId: at(GAP_START - 60_000) });
  const active = channel({ id: at(NOW - 86_400_000), lastMessageId: at(t) });
  const created = channel({ id: at(t), lastMessageId: at(t) });
  const otherParent = channel({ id: at(NOW - 86_400_000), parentId: "elsewhere", lastMessageId: at(t) });
  const vip = channel({ id: "vip", isThread: false, parentId: null, lastMessageId: at(t) });
  const requireThread = channel({ id: "help", isThread: false, parentId: null, lastMessageId: at(t) });
  const unlinked = channel({ id: at(NOW - 86_400_000), guildId: "g2", lastMessageId: at(t) });
  const plan = planBackfill([quiet, active, created, otherParent, vip, requireThread, unlinked], scope({}), gapId);
  const ids = plan.map((p) => p.channel);
  check("a channel without a message in the gap is not read", !ids.includes(quiet));
  check("an active thread in scope is read", ids.includes(active));
  check("a thread created in the gap is flagged", plan.find((p) => p.channel === created)?.createdInGap === true);
  check("an active thread created earlier is not flagged", plan.find((p) => p.channel === active)?.createdInGap === false);
  check("a thread under an unbound channel is not read", !ids.includes(otherParent));
  check("top-level messages are read where they are ingested", ids.includes(vip) && !ids.includes(requireThread));
  check("an unlinked guild is not read", !ids.includes(unlinked));
  const all = planBackfill([otherParent, vip], scope({ all: true }), gapId).map((p) => p.channel);
  check("a guild without bindings reads every active thread but no top-level channel", all.includes(otherParent) && !all.includes(vip));

  // Paging, the per-ticket hand-off, and the order of a new thread's seat and its messages.
  const many = Array.from({ length: 230 }, (_, i) => ({ id: at(GAP_START + 1000 + i), ticketId: i < 200 ? "T1" : "T2" }));
  const busy = channel({ id: at(t), lastMessageId: many[many.length - 1].id }, many);
  const events: string[] = [];
  const handed: string[] = [];
  const s = await backfillChannels(
    [busy],
    scope({}),
    GAP_START,
    {
      onThreadCreated: async () => { events.push("seat"); },
      onMessage: async (m) => { if (!events.includes("msg")) events.push("msg"); return { tenantId: A, ticketId: m.ticketId!, messageId: m.id }; },
      onTicketBackfilled: async (_t, ticketId, messageId) => { handed.push(`${ticketId}:${messageId}`); },
      abortOn: () => false,
    },
    NOW,
  );
  check("all messages are handled across pages", s.messages === 230 && busy.fetches.length === 3, { messages: s.messages, fetches: busy.fetches.length });
  check("each page starts after the last message of the one before", busy.fetches[1] === many[99].id && busy.fetches[2] === many[199].id);
  check("a new thread is seated before its messages", events[0] === "seat" && events[1] === "msg");
  check("each ticket is handed on once, with its newest message", handed.length === 2 && handed.includes(`T1:${many[199].id}`) && handed.includes(`T2:${many[229].id}`), handed);

  const endless = Array.from({ length: 700 }, (_, i) => ({ id: at(GAP_START + 1000 + i), ticketId: "T3" }));
  const flood = channel({ id: at(NOW - 86_400_000), lastMessageId: endless[699].id }, endless);
  const capped = await backfillChannels([flood], scope({}), GAP_START, { onThreadCreated: async () => {}, onMessage: async () => null, onTicketBackfilled: async () => {}, abortOn: () => false }, NOW);
  check("a channel is read at most 5 pages deep", capped.messages === 500 && capped.truncated === true, capped);

  const old = await backfillChannels([], scope({}), NOW - 30 * 86_400_000, { onThreadCreated: async () => {}, onMessage: async () => null, onTicketBackfilled: async () => {}, abortOn: () => false }, NOW);
  check("a gap longer than a week is clamped to a week", old.gapSeconds === 7 * 86_400, old.gapSeconds);

  // A VIP ticket spans its top-level channel and its thread, and is handed on once for both.
  const vipTop = channel({ id: "vip", isThread: false, parentId: null, lastMessageId: at(t) }, [{ id: at(t - 2000), ticketId: "TV" }]);
  const vipThread = channel({ id: at(t - 2000), parentId: "vip", lastMessageId: at(t) }, [{ id: at(t - 1000), ticketId: "TV" }, { id: at(t), ticketId: "TV" }]);
  const vipHanded: string[] = [];
  await backfillChannels([vipTop, vipThread], scope({ threadParents: new Set(["forum", "vip"]) }), GAP_START, {
    onThreadCreated: async () => {},
    onMessage: async (m) => ({ tenantId: A, ticketId: m.ticketId!, messageId: m.id }),
    onTicketBackfilled: async (_t, ticketId, messageId) => { vipHanded.push(`${ticketId}:${messageId}`); },
    abortOn: () => false,
  }, NOW);
  check("a ticket across two channels is handed on once, with its newest message", vipHanded.length === 1 && vipHanded[0] === `TV:${at(t)}`, vipHanded);

  // One message that fails to process doesn't stop the rest of its channel.
  const three = [{ id: at(t - 2000), ticketId: "T5" }, { id: at(t - 1000), ticketId: "T5" }, { id: at(t), ticketId: "T5" }];
  const seenIds: string[] = [];
  const partly = await backfillChannels([channel({ id: at(NOW - 86_400_000), lastMessageId: at(t) }, three)], scope({}), GAP_START, {
    onThreadCreated: async () => {},
    onMessage: async (m) => { seenIds.push(m.id); if (m.id === three[0].id) throw new Error("db hiccup"); return null; },
    onTicketBackfilled: async () => {},
    abortOn: () => false,
  }, NOW);
  check("a failing message is counted and the channel goes on", partly.failedMessages === 1 && partly.failed === 0 && seenIds.length === 3, partly);

  // A ticket in the channel that aborts waits for the retry. One finished earlier is handed on.
  const done = channel({ id: at(NOW - 86_400_000), lastMessageId: at(t) }, [{ id: at(t), ticketId: "T6" }]);
  const halfMsgs = Array.from({ length: 100 }, (_, i) => ({ id: at(GAP_START + 1000 + i), ticketId: "T7" }));
  const stopErr = new Error("rate limited mid-channel");
  let calls = 0;
  const half = channel({
    id: at(NOW - 86_400_000), lastMessageId: at(t),
    fetchAfter: async () => { if (calls++ === 0) return halfMsgs; throw stopErr; },
  });
  const handedAbort: string[] = [];
  await backfillChannels([done, half], scope({}), GAP_START, {
    onThreadCreated: async () => {},
    onMessage: async (m) => ({ tenantId: A, ticketId: m.ticketId!, messageId: m.id }),
    onTicketBackfilled: async (_t, ticketId) => { handedAbort.push(ticketId); },
    abortOn: (e) => e === stopErr,
  }, NOW);
  check("an abort hands on finished tickets and holds back the aborting channel's", handedAbort.length === 1 && handedAbort[0] === "T6", handedAbort);

  // The abort hit the page after a full one, so every message of T8 is a replay on the retry.
  const fullId = at(NOW - 86_400_000 + 1);
  const fullMsgs = Array.from({ length: 100 }, (_, i) => ({ id: at(GAP_START + 1000 + i), ticketId: "T8" }));
  let fullCalls = 0;
  const full = channel({
    id: fullId, lastMessageId: at(t),
    fetchAfter: async (after) => {
      if (fullCalls++ === 1) throw stopErr;
      return fullMsgs.filter((m) => BigInt(m.id) > BigInt(after)).slice(0, 100);
    },
  });
  const later = channel({ id: at(NOW - 86_400_000 + 2), lastMessageId: at(t) }, [{ id: at(t), ticketId: "T9" }]);
  const first = await backfillChannels([full, later], scope({}), GAP_START, {
    onThreadCreated: async () => {},
    onMessage: async (m) => ({ tenantId: A, ticketId: m.ticketId!, messageId: m.id }),
    onTicketBackfilled: async () => {},
    abortOn: (e) => e === stopErr,
  }, NOW);
  check("an abort returns the aborting channel's tickets for the retry", first.heldBack.get(fullId)?.has("T8") === true, [...first.heldBack.keys()]);
  const retried: string[] = [];
  await backfillChannels([full, later], scope({}), GAP_START, {
    onThreadCreated: async () => {},
    onMessage: async () => null,
    onTicketBackfilled: async (_t, ticketId) => { retried.push(ticketId); },
    abortOn: (e) => e === stopErr,
  }, NOW, first.heldBack);
  check("the retry hands on a held-back ticket whose messages are all replays", retried.length === 1 && retried[0] === "T8", retried);

  // A carried ticket waits again when the retry aborts before its channel is read to the end.
  const stillDown = channel({ id: fullId, lastMessageId: at(t), fetchAfter: async () => { throw stopErr; } });
  const again = await backfillChannels([stillDown], scope({}), GAP_START, {
    onThreadCreated: async () => {},
    onMessage: async () => null,
    onTicketBackfilled: async (_t, ticketId) => { retried.push(ticketId); },
    abortOn: (e) => e === stopErr,
  }, NOW, first.heldBack);
  check("a carried ticket stays held back when its channel aborts again", retried.length === 1 && again.heldBack.get(fullId)?.has("T8") === true, retried);

  // A ticket across a finished channel and an aborting one is handed on once, after the retry.
  const spanTop = channel({ id: "vip", isThread: false, parentId: null, lastMessageId: at(t) }, [{ id: at(t - 2000), ticketId: "T10" }]);
  const spanThread = channel({ id: at(NOW - 86_400_000 + 3), lastMessageId: at(t) }, [
    { id: at(t - 1000), ticketId: "T10" },
    { id: at(t - 500), ticketId: "T10-limited" },
  ]);
  const spanHanded: string[] = [];
  const spanFirst = await backfillChannels([spanTop, spanThread], scope({}), GAP_START, {
    onThreadCreated: async () => {},
    onMessage: async (m) => {
      if (m.ticketId === "T10-limited") throw stopErr;
      return { tenantId: A, ticketId: m.ticketId!, messageId: m.id };
    },
    onTicketBackfilled: async (_t, ticketId) => { spanHanded.push(ticketId); },
    abortOn: (e) => e === stopErr,
  }, NOW);
  check("a ticket held back in one channel isn't handed on by another", spanHanded.length === 0, spanHanded);
  await backfillChannels([spanTop, spanThread], scope({}), GAP_START, {
    onThreadCreated: async () => {},
    onMessage: async () => null,
    onTicketBackfilled: async (_t, ticketId) => { spanHanded.push(ticketId); },
    abortOn: (e) => e === stopErr,
  }, NOW, spanFirst.heldBack);
  check("and the retry hands it on once", spanHanded.length === 1 && spanHanded[0] === "T10", spanHanded);

  // A carried channel that is gone, e.g. a deleted thread, hands its tickets on.
  const goneHanded: string[] = [];
  await backfillChannels([], scope({}), GAP_START, {
    onThreadCreated: async () => {},
    onMessage: async () => null,
    onTicketBackfilled: async (_t, ticketId) => { goneHanded.push(ticketId); },
    abortOn: () => false,
  }, NOW, new Map([["deleted-thread", new Map([["T11", { tenantId: A, messageId: "m11" }]])]]));
  check("a carried ticket whose channel is gone is handed on", goneHanded.length === 1 && goneHanded[0] === "T11", goneHanded);

  // An unreadable channel is skipped. An aborting error stops the run.
  const broken = channel({ id: at(NOW - 86_400_000), lastMessageId: at(t), fetchAfter: async () => { throw new Error("Missing Access"); } });
  const after = channel({ id: at(NOW - 86_400_000), lastMessageId: at(t) }, [{ id: at(t), ticketId: "T4" }]);
  const skip = await backfillChannels([broken, after], scope({}), GAP_START, { onThreadCreated: async () => {}, onMessage: async () => null, onTicketBackfilled: async () => {}, abortOn: () => false }, NOW);
  check("an unreadable channel is skipped and the run goes on", skip.failed === 1 && skip.fetched === 2 && skip.messages === 1, skip);
  const limited = new Error("rate limited");
  const stop = await backfillChannels(
    [channel({ ...broken, id: broken.id, fetchAfter: async () => { throw limited; } }), after],
    scope({}), GAP_START,
    { onThreadCreated: async () => {}, onMessage: async () => null, onTicketBackfilled: async () => {}, abortOn: (e) => e === limited },
    NOW,
  );
  check("an aborting error stops the run", stop.abortedBy === limited && stop.fetched === 1, { fetched: stop.fetched });
}

async function withDb() {
  const superPool = new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432), database: process.env.DB_NAME,
    user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 1,
  });
  const clean = async () => {
    const t = "SELECT id FROM tickets WHERE external_channel_id LIKE 'bftest-%' OR external_guild_id = 'BFTEST-guild'";
    await superPool.query(`DELETE FROM messages WHERE ticket_id IN (${t})`);
    await superPool.query(`DELETE FROM tickets WHERE id IN (${t})`);
    await superPool.query("DELETE FROM contacts WHERE tenant_id = $1 AND external_id LIKE 'bftest-%'", [A]);
    await superPool.query("DELETE FROM discord_channel_bindings WHERE guild_id = $1", [GUILD]);
    await superPool.query("DELETE FROM discord_mirror_bindings WHERE guild_id = $1", [GUILD]);
    await superPool.query("DELETE FROM discord_links WHERE guild_id = $1", [GUILD]);
    await superPool.query("DELETE FROM discord_gateway_heartbeat WHERE bot_id LIKE 'bftest-%'");
  };
  await clean();

  // ── scopes from the guild's bindings ──
  await linkGuild(GUILD, A);
  const unbound = (await loadGuildScopes([GUILD, "BFTEST-unlinked"])).get(GUILD);
  check("a linked guild without bindings monitors everything", unbound?.all === true);
  check("an unlinked guild has no scope", !(await loadGuildScopes(["BFTEST-unlinked"])).has("BFTEST-unlinked"));
  await superPool.query(
    `INSERT INTO discord_channel_bindings (guild_id, channel_id, tenant_id, mode, require_thread, thread_per_message) VALUES
       ($1, 'bf-help', $2, 'staffed', true, false), ($1, 'bf-vip', $2, 'staffed', true, true), ($1, 'bf-off', $2, 'off', true, false)`,
    [GUILD, A],
  );
  await superPool.query(
    "INSERT INTO discord_mirror_bindings (tenant_id, guild_id, forum_channel_id, enabled) VALUES ($1, $2, 'bf-mirror', true)",
    [A, GUILD],
  );
  const bound = (await loadGuildScopes([GUILD])).get(GUILD)!;
  check("bindings switch the guild to its bound channels", bound.all === false);
  check("bound channels and mirror forums have their threads read", bound.threadParents.has("bf-help") && bound.threadParents.has("bf-vip") && bound.threadParents.has("bf-mirror"));
  check("an 'off' binding is not read", !bound.threadParents.has("bf-off"));
  check("only VIP channels have top-level messages read", bound.topLevel.has("bf-vip") && !bound.topLevel.has("bf-help"));

  // ── the heartbeat ──
  check("no heartbeat yet", (await lastSeenConnected("bftest-bot")) === null);
  await recordSeenConnected(["bftest-bot"]);
  const seen = await lastSeenConnected("bftest-bot");
  check("the heartbeat records when the bot was seen", seen !== null && Math.abs(Date.now() - seen) < 60_000, seen);

  // ── unanswered customer messages are combined for one autoreply ──
  const q1 = await ingestInbound({
    tenantId: A, body: "BFTEST first question", authorType: "customer", channelType: "discord", externalChannelId: "bftest-thread-1",
    threadingPolicy: "thread", externalThreadId: "bftest-thread-1", identity: { externalId: "bftest-cust", name: "BF" }, idempotencyKey: "bftest:1", skipAutoreply: true,
  });
  await ingestInbound({ tenantId: A, body: "BFTEST answer", authorType: "agent", ticketId: q1.ticketId, channelType: "discord", externalChannelId: "bftest-thread-1", idempotencyKey: "bftest:2" });
  for (const [i, body] of [[3, "BFTEST second question"], [4, "BFTEST third question"]] as const) {
    await ingestInbound({
      tenantId: A, body, authorType: "customer", channelType: "discord", externalChannelId: "bftest-thread-1", threadingPolicy: "thread",
      externalThreadId: "bftest-thread-1", identity: { externalId: "bftest-cust", name: "BF" }, idempotencyKey: `bftest:${i}`, skipAutoreply: true,
    });
  }
  const combined = await unansweredCustomerText(A, q1.ticketId);
  check("only messages after the last agent reply are combined, oldest first", combined === "BFTEST second question\n\nBFTEST third question", combined);

  // ── a VIP message seen again isn't anchored again ──
  const anchors: string[] = [];
  const mock = {
    async createMessageThread(_channelId: string, messageId: string) { anchors.push(messageId); return { threadId: `bftest-vip-thread-${messageId}` }; },
  } as unknown as MirrorTransport;
  setMirrorTransportForTests(mock);
  const vipMsg = {
    guildId: GUILD, channelId: "bf-vip", authorId: "bftest-cust-vip", content: "BFTEST vip question", discordMessageId: "bftest-vip-1",
    threadId: null, parentId: null, threadKind: "channel" as const, authorDisplayName: "BF VIP", isBotOrWebhook: false, skipAutoreply: true,
  };
  const first = await handleInboundMessage(vipMsg);
  const again = await handleInboundMessage(vipMsg);
  check("a VIP message is anchored once", !!first && anchors.length === 1, anchors);
  check("seeing it again replays onto the same ticket", !!again && again.replay && again.ticketId === first!.ticketId && anchors.length === 1);
  setMirrorTransportForTests(null);

  await clean();
  await superPool.end();
}

async function main() {
  await pure();
  await withDb();
  await appPool.end();
  await relayPool.end();
  if (failures > 0) {
    console.error(`\nDISCORD-BACKFILL: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nDISCORD-BACKFILL: all checks green");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
