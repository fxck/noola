import pg from "pg";
import { relayPool, withTenant } from "@repo/db";
import {
  setMirrorTransportForTests, replaceMirrorBindings, listMirrorBindings,
  evaluateAutoMirror, pushTicketToDiscord, getTicketMirror, mirrorByThread, mirrorUrl,
  matchesMirrorFilter, relayTicketMessage, syncMirrorState,
  handleMirrorPostMessage, handleMirrorReaction, PROMOTE_EMOJI,
} from "../src/discord-mirror.js";
import type { MirrorTransport } from "../src/discord-gateway.js";
import { ingestInbound } from "../src/ingest.js";

// Discord forum ops-mirror gate (PILOT-AND-DISCORD-PLAN D1-D4): binding filter → forum post,
// manual push, timeline relay into the post, note-by-default responder messages, 📤 promote-to-
// reply with the role gate + single-promotion claim, lifecycle tag/archive sync, echo-guard —
// all against a mock transport (no live gateway). Data is MIRTEST/mirtest- prefixed.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const GUILD = "MIRTEST-guild";
const FORUM = "mirtest-forum-1";
const ROLE = "mirtest-responder-role";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

// ── Mock transport: records every call, mints deterministic thread ids ────────
interface Call { fn: string; args: unknown[] }
const calls: Call[] = [];
let threadSeq = 0;
const archived = new Map<string, boolean>();
const appliedTags = new Map<string, string[]>();
const mock: MirrorTransport = {
  async listForums() { return [{ id: FORUM, name: "support-tickets" }]; },
  async listRoles() { return [{ id: ROLE, name: "Noola Responder" }]; },
  async listTextChannels() { return []; },
  async createMessageThread() { return null; },
  async createForumPost(forumChannelId, name, content, tagNames) {
    calls.push({ fn: "createForumPost", args: [forumChannelId, name, content, tagNames] });
    const threadId = `mirtest-thread-${++threadSeq}`;
    appliedTags.set(threadId, tagNames);
    return { threadId };
  },
  async postToThread(threadId, content) {
    calls.push({ fn: "postToThread", args: [threadId, content] });
    return true;
  },
  async setArchived(threadId, a) {
    calls.push({ fn: "setArchived", args: [threadId, a] });
    archived.set(threadId, a);
    return true;
  },
  async applyTags(threadId, tagNames) {
    calls.push({ fn: "applyTags", args: [threadId, tagNames] });
    appliedTags.set(threadId, tagNames);
    return true;
  },
  async react(threadId, messageId, emoji) {
    calls.push({ fn: "react", args: [threadId, messageId, emoji] });
    return true;
  },
  async memberRoleIds() { return []; },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mintTicket(tag: string, priority = "normal"): Promise<string> {
  const res = await ingestInbound({
    tenantId: A,
    body: `MIRTEST question ${tag}`,
    authorType: "customer",
    channelType: "widget",
    externalChannelId: `mirtest-w-${tag}`,
    identity: { externalId: `mirtest-c-${tag}`, name: `Mir Tester ${tag}` },
    idempotencyKey: `mirtest:${tag}:1`,
    skipAutoreply: true,
  });
  if (priority !== "normal") {
    await withTenant(A, (c) => c.query("UPDATE tickets SET priority = $1 WHERE id = $2", [priority, res.ticketId]));
  }
  return res.ticketId;
}

async function main() {
  const superPool = new pg.Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_SUPER_USER,
    password: process.env.DB_SUPER_PASSWORD,
    max: 1,
  });

  const clean = async () => {
    await superPool.query("DELETE FROM ticket_mirror_messages WHERE discord_message_id LIKE 'mirtest-%'");
    await superPool.query("DELETE FROM ticket_mirror WHERE guild_id = $1", [GUILD]);
    await superPool.query("DELETE FROM discord_mirror_bindings WHERE guild_id = $1", [GUILD]);
    const t = "SELECT id FROM tickets WHERE external_channel_id LIKE 'mirtest-%'";
    await superPool.query(`DELETE FROM ticket_notes WHERE ticket_id IN (${t})`);
    await superPool.query(`DELETE FROM answer_claims WHERE message_id IN (SELECT id FROM messages WHERE ticket_id IN (${t}))`);
    await superPool.query(`DELETE FROM messages WHERE ticket_id IN (${t})`);
    await superPool.query(`DELETE FROM contacts WHERE tenant_id = $1 AND name LIKE 'Mir Tester%'`, [A]);
    await superPool.query("DELETE FROM agent_channel_identities WHERE external_id LIKE 'mirtest-%'");
    // ✅-triage emits ticket.closed → the seeded survey flow may mint rows; best-effort sweep.
    for (const q of [
      `DELETE FROM surveys WHERE ticket_id IN (${t})`,
      `DELETE FROM survey_requests WHERE ticket_id IN (${t})`,
    ]) await superPool.query(q).catch(() => {});
    await superPool.query(`DELETE FROM tickets WHERE external_channel_id LIKE 'mirtest-%'`);
  };
  await clean();
  setMirrorTransportForTests(mock);

  // ── bindings CRUD ───────────────────────────────────────────────────────────

  // Snapshot the tenant's REAL mirror bindings — replaceMirrorBindings is a tenant-wide full
  // replace on the SHARED demo DB, so without restore the suite deletes the owner's live config
  // (bit us 2026-07-17: every battery run wiped the saved Discord mirror).
  const realMirrorBindings = await listMirrorBindings(A);
  const bindings = await replaceMirrorBindings(A, [{
    guildId: GUILD, forumChannelId: FORUM, enabled: true,
    responderRoleId: ROLE, attributionMode: "team", attributionName: "Acme Support",
    filter: { priorities: ["urgent"] },
  }]);
  check("binding created", bindings.length === 1 && bindings[0].forum_channel_id === FORUM);
  check("binding filter round-trips", bindings[0].filter.priorities?.[0] === "urgent");
  const again = await replaceMirrorBindings(A, [{
    guildId: GUILD, forumChannelId: FORUM, enabled: true,
    responderRoleId: ROLE, attributionMode: "team", attributionName: "Acme Support",
    filter: { priorities: ["urgent"] },
  }]);
  check("replace is upsert (same forum keeps one row)", again.length === 1 && again[0].id === bindings[0].id);

  // ── matchesMirrorFilter units ───────────────────────────────────────────────
  const base = { id: "x", subject: "s", status: "open", priority: "urgent", tags: ["billing"], topic: "bug", team_id: null, channel_type: "email", contact_name: null, contact_email: null };
  check("filter: empty matches all", matchesMirrorFilter(base, {}));
  check("filter: priority match", matchesMirrorFilter(base, { priorities: ["urgent"] }));
  check("filter: priority miss", !matchesMirrorFilter(base, { priorities: ["low"] }));
  check("filter: tag overlap", matchesMirrorFilter(base, { tags: ["billing", "other"] }));
  check("filter: topic match", matchesMirrorFilter(base, { topics: ["bug"] }));
  check("filter: channel miss", !matchesMirrorFilter(base, { channels: ["widget"] }));
  check("filter: discord-origin never mirrors", !matchesMirrorFilter({ ...base, channel_type: "discord" }, {}));

  // ── D1: auto-mirror on filter match ────────────────────────────────────────
  const t1 = await mintTicket("auto", "normal");
  await evaluateAutoMirror(A, t1);
  check("no mirror below filter", (await getTicketMirror(A, t1)) === null);

  await withTenant(A, (c) => c.query("UPDATE tickets SET priority = 'urgent' WHERE id = $1", [t1]));
  await evaluateAutoMirror(A, t1);
  const m1 = await getTicketMirror(A, t1);
  check("mirror created on match", !!m1 && m1.post_thread_id.startsWith("mirtest-thread-"));
  check("mirror url shape", !!m1 && mirrorUrl(m1) === `https://discord.com/channels/${GUILD}/${m1.post_thread_id}`);
  const createCall = calls.find((c) => c.fn === "createForumPost");
  check("post created in the bound forum", createCall?.args[0] === FORUM);
  check("post content carries the customer msg", String(createCall?.args[2]).includes("MIRTEST question auto"));
  check("post tags = status+priority", JSON.stringify(createCall?.args[3]) === JSON.stringify(["open", "urgent"]));
  await evaluateAutoMirror(A, t1);
  check("re-evaluate is idempotent (one post)", calls.filter((c) => c.fn === "createForumPost").length === 1);
  check("reverse lookup by thread", (await mirrorByThread(m1!.post_thread_id))?.ticket_id === t1);

  // ── D1: manual push ignores the filter ─────────────────────────────────────
  const t2 = await mintTicket("manual", "normal");
  const pushed = await pushTicketToDiscord(A, t2);
  check("manual push mirrors regardless of filter", !!pushed.mirror);
  const pushedAgain = await pushTicketToDiscord(A, t2);
  check("manual push idempotent", pushedAgain.mirror?.post_thread_id === pushed.mirror?.post_thread_id);

  // ── D2: timeline relay into the post ───────────────────────────────────────
  calls.length = 0;
  const follow = await ingestInbound({
    tenantId: A, body: "MIRTEST follow-up from customer", authorType: "customer",
    channelType: "widget", externalChannelId: "mirtest-w-auto",
    identity: { externalId: "mirtest-c-auto", name: "Mir Tester auto" },
    idempotencyKey: "mirtest:auto:2", ticketId: t1, skipAutoreply: true,
  });
  await relayTicketMessage(A, t1, follow.messageId);
  const posts = calls.filter((c) => c.fn === "postToThread");
  check("customer follow-up relayed into the post", posts.some((c) => String(c.args[1]).includes("MIRTEST follow-up from customer")));
  check("relay labels the customer", posts.some((c) => String(c.args[1]).includes("Mir Tester auto")));

  const agentMsg = await ingestInbound({
    tenantId: A, body: "MIRTEST console agent reply", authorType: "agent",
    ticketId: t1, idempotencyKey: "mirtest:auto:3",
  });
  await relayTicketMessage(A, t1, agentMsg.messageId);
  check("console agent reply relayed as sent-to-customer", calls.some((c) => c.fn === "postToThread" && String(c.args[1]).includes("reply sent to customer") && String(c.args[1]).includes("MIRTEST console agent reply")));

  // ── D3: responder message → internal note ──────────────────────────────────
  const thread1 = m1!.post_thread_id;
  const noteRes = await handleMirrorPostMessage({
    guildId: GUILD, threadId: thread1, discordMessageId: "mirtest-dm-1",
    authorId: "mirtest-user-bob", authorDisplayName: "Bob",
    content: "MIRTEST internal thought from Bob", roleIds: [ROLE], isBotOrWebhook: false,
  });
  check("mirror-post message handled (not customer ingest)", noteRes.handled && !!noteRes.noteId);
  const notes = await withTenant(A, (c) => c.query("SELECT author_name, body FROM ticket_notes WHERE ticket_id = $1", [t1]));
  check("note lands on the ticket, Discord-attributed", notes.rows.some((r) => r.author_name === "Bob (Discord)" && r.body === "MIRTEST internal thought from Bob"));
  const tmm = await relayPool.query("SELECT is_responder, promoted_at FROM ticket_mirror_messages WHERE discord_message_id = 'mirtest-dm-1'");
  check("promotion ledger row (responder)", tmm.rowCount === 1 && tmm.rows[0].is_responder === true && tmm.rows[0].promoted_at === null);

  const outsider = await handleMirrorPostMessage({
    guildId: GUILD, threadId: thread1, discordMessageId: "mirtest-dm-2",
    authorId: "mirtest-user-eve", authorDisplayName: "Eve",
    content: "MIRTEST outsider comment", roleIds: [], isBotOrWebhook: false,
  });
  check("non-responder message still a note", outsider.handled && !!outsider.noteId);
  const tmm2 = await relayPool.query("SELECT is_responder FROM ticket_mirror_messages WHERE discord_message_id = 'mirtest-dm-2'");
  check("non-responder flagged ineligible", tmm2.rows[0].is_responder === false);

  const bot = await handleMirrorPostMessage({
    guildId: GUILD, threadId: thread1, discordMessageId: "mirtest-dm-3",
    authorId: "mirtest-bot", authorDisplayName: "Noola", content: "relayed body", roleIds: [], isBotOrWebhook: true,
  });
  check("echo-guard: bot message swallowed, no note", bot.handled && !bot.noteId);
  const nonMirror = await handleMirrorPostMessage({
    guildId: GUILD, threadId: "mirtest-not-a-mirror", discordMessageId: "mirtest-dm-4",
    authorId: "u", authorDisplayName: null, content: "x", roleIds: [], isBotOrWebhook: false,
  });
  check("non-mirror thread falls through", nonMirror.handled === false);

  // ── D3: 📤 promotion — role gate + exactly-once ────────────────────────────
  const wrongEmoji = await handleMirrorReaction({ guildId: GUILD, threadId: thread1, discordMessageId: "mirtest-dm-1", reactorId: "mirtest-user-bob", emoji: "👍", reactorRoleIds: [ROLE] });
  check("non-📤, unmapped emoji ignored", !wrongEmoji.promoted && wrongEmoji.reason === "unmapped_emoji");
  const noRole = await handleMirrorReaction({ guildId: GUILD, threadId: thread1, discordMessageId: "mirtest-dm-1", reactorId: "mirtest-user-eve", emoji: PROMOTE_EMOJI, reactorRoleIds: [] });
  check("role gate blocks a non-responder reactor", !noRole.promoted && noRole.reason === "not_responder");
  const onOutsider = await handleMirrorReaction({ guildId: GUILD, threadId: thread1, discordMessageId: "mirtest-dm-2", reactorId: "mirtest-user-bob", emoji: PROMOTE_EMOJI, reactorRoleIds: [ROLE] });
  check("non-responder message not promotable", !onOutsider.promoted && onOutsider.reason === "not_promotable");

  calls.length = 0;
  const promoted = await handleMirrorReaction({ guildId: GUILD, threadId: thread1, discordMessageId: "mirtest-dm-1", reactorId: "mirtest-user-bob", emoji: PROMOTE_EMOJI, reactorRoleIds: [ROLE] });
  check("responder 📤 promotes", promoted.promoted === true);
  const agentRow = await withTenant(A, (c) => c.query(
    "SELECT author_type, author_kind, author_external_name, body FROM messages WHERE ticket_id = $1 AND body = 'MIRTEST internal thought from Bob'", [t1]));
  check("promotion minted an agent reply on the ticket", agentRow.rowCount === 1 && agentRow.rows[0].author_type === "agent");
  check("team attribution on the reply", agentRow.rows[0].author_external_name === "Acme Support");
  check("promoted message ✅-acknowledged", calls.some((c) => c.fn === "react" && c.args[2] === "✅"));
  const ledger = await relayPool.query("SELECT promoted_at, promoted_message_id FROM ticket_mirror_messages WHERE discord_message_id = 'mirtest-dm-1'");
  check("ledger stamped promoted", ledger.rows[0].promoted_at !== null && ledger.rows[0].promoted_message_id !== null);
  const doublePromo = await handleMirrorReaction({ guildId: GUILD, threadId: thread1, discordMessageId: "mirtest-dm-1", reactorId: "mirtest-user-bob", emoji: PROMOTE_EMOJI, reactorRoleIds: [ROLE] });
  check("second 📤 is a no-op (exactly-once)", !doublePromo.promoted && doublePromo.reason === "not_promotable");
  await sleep(300); // let the fire-and-forget relay hooks settle
  check("promoted reply NOT echoed back into the post", !calls.some((c) => c.fn === "postToThread" && String(c.args[1]).includes("MIRTEST internal thought from Bob")));

  // ── D4: lifecycle — close archives, reopen unarchives ──────────────────────
  calls.length = 0;
  // Re-assert priority in the same write: live tenant automations on the shared demo DB (user-
  // authored flows) may re-classify priority off inbound messages — this check is about TAG SYNC,
  // not priority persistence, so pin the state we're asserting on.
  await withTenant(A, (c) => c.query("UPDATE tickets SET status = 'closed', priority = 'urgent' WHERE id = $1", [t1]));
  await syncMirrorState(A, t1);
  check("close archives the post", archived.get(thread1) === true);
  check("closed tag applied", JSON.stringify(appliedTags.get(thread1)) === JSON.stringify(["closed", "urgent"]));
  await withTenant(A, (c) => c.query("UPDATE tickets SET status = 'open' WHERE id = $1", [t1]));
  await syncMirrorState(A, t1);
  check("reopen unarchives the post", archived.get(thread1) === false);

  // ── D6: reaction triage on the mirror post (the shared Slack map) ──────────
  const { canonicalEmojiName, getReactionMap } = await import("../src/classification.js");
  check("emoji canon: ✅ → white_check_mark", canonicalEmojiName("✅") === "white_check_mark");
  check("emoji canon: ✔️ strips VS-16", canonicalEmojiName("✔️") === "heavy_check_mark");
  check("emoji canon: :zzz: paste passes through", canonicalEmojiName(":zzz:") === "zzz");

  // READ-only on the tenant's live map (shared demo DB — never mutate classification tables here).
  const liveMap = await getReactionMap(A);
  const triageReady =
    liveMap["white_check_mark"] === "close" && liveMap["arrows_counterclockwise"] === "reopen" &&
    liveMap["zzz"] === "snooze" && liveMap["eyes"] === "assign_me";
  check("tenant reaction map carries the triage defaults", triageReady);

  if (triageReady) {
    calls.length = 0;
    const closeRes = await handleMirrorReaction({ guildId: GUILD, threadId: thread1, discordMessageId: "mirtest-dm-1", reactorId: "mirtest-user-bob", emoji: "✅", reactorRoleIds: [ROLE] });
    check("✅ triages close", closeRes.action === "close" && !closeRes.reason);
    const closedRow = await withTenant(A, (c) => c.query("SELECT status FROM tickets WHERE id = $1", [t1]));
    check("✅ closed the ticket", closedRow.rows[0].status === "closed");
    check("✅ archived the post", archived.get(thread1) === true);
    check("🆗 confirmation react", calls.some((c) => c.fn === "react" && c.args[2] === "🆗"));

    const gateRes = await handleMirrorReaction({ guildId: GUILD, threadId: thread1, discordMessageId: "mirtest-dm-1", reactorId: "mirtest-user-eve", emoji: "🔄", reactorRoleIds: [] });
    check("triage role gate blocks outsiders", gateRes.reason === "not_responder");

    const reopenRes = await handleMirrorReaction({ guildId: GUILD, threadId: thread1, discordMessageId: "mirtest-dm-1", reactorId: "mirtest-user-bob", emoji: "🔄", reactorRoleIds: [ROLE] });
    check("🔄 triages reopen", reopenRes.action === "reopen" && !reopenRes.reason);
    const reopened = await withTenant(A, (c) => c.query("SELECT status FROM tickets WHERE id = $1", [t1]));
    check("🔄 reopened the ticket", reopened.rows[0].status === "open");
    check("🔄 unarchived the post", archived.get(thread1) === false);

    const snoozeRes = await handleMirrorReaction({ guildId: GUILD, threadId: thread1, discordMessageId: "mirtest-dm-1", reactorId: "mirtest-user-bob", emoji: "💤", reactorRoleIds: [ROLE] });
    check("💤 triages snooze", snoozeRes.action === "snooze" && !snoozeRes.reason);
    const snoozed = await withTenant(A, (c) => c.query("SELECT snoozed_until FROM tickets WHERE id = $1", [t1]));
    check("💤 set a future snooze", snoozed.rows[0].snoozed_until !== null && new Date(snoozed.rows[0].snoozed_until as string).getTime() > Date.now());

    // 👀 assign-to-me: unmarked reactor → helpful in-thread hint, no assignment.
    calls.length = 0;
    const noSeat = await handleMirrorReaction({ guildId: GUILD, threadId: thread1, discordMessageId: "mirtest-dm-1", reactorId: "mirtest-user-bob", emoji: "👀", reactorRoleIds: [ROLE] });
    check("👀 without a linked seat refuses", noSeat.action === "assign_me" && noSeat.reason === "no_seat");
    check("👀 refusal hints at Settings → Members", calls.some((c) => c.fn === "postToThread" && String(c.args[1]).includes("Settings → Members")));

    // Link the reactor to a real seat (snapshot/restore that seat's live mark — shared demo DB).
    const { upsertAgentChannelIdentity, removeAgentChannelIdentity, resolveTeammate } = await import("../src/discord-classify.js");
    const seat = await withTenant(A, (c) => c.query("SELECT id FROM users ORDER BY name ASC LIMIT 1"));
    const seatId = seat.rows[0].id as string;
    const prevMark = await withTenant(A, (c) => c.query(
      "SELECT external_id FROM agent_channel_identities WHERE user_id = $1 AND channel_type = 'discord'", [seatId]));
    await upsertAgentChannelIdentity(A, seatId, "mirtest-user-bob");
    check("teammate mark resolves the seat", (await resolveTeammate(A, "mirtest-user-bob")) === seatId);
    // No role passed — the explicit mark alone must clear the responder gate.
    const assignRes = await handleMirrorReaction({ guildId: GUILD, threadId: thread1, discordMessageId: "mirtest-dm-1", reactorId: "mirtest-user-bob", emoji: "👀", reactorRoleIds: [] });
    check("👀 assigns to the linked seat (mark bypasses role gate)", assignRes.action === "assign_me" && !assignRes.reason);
    const asg = await withTenant(A, (c) => c.query("SELECT assignee_id FROM tickets WHERE id = $1", [t1]));
    check("assignee persisted", asg.rows[0].assignee_id === seatId);
    await removeAgentChannelIdentity(A, seatId, "discord");
    if (prevMark.rowCount) await upsertAgentChannelIdentity(A, seatId, prevMark.rows[0].external_id as string);
    await sleep(300); // let close-event automations settle before cleanup
  }

  // ── binding removal cascades its mirrors ───────────────────────────────────
  await replaceMirrorBindings(A, []);
  check("bindings cleared", (await listMirrorBindings(A)).length === 0);
  check("mirror rows cascade with the binding", (await getTicketMirror(A, t1)) === null);

  // Restore the owner's real bindings (see snapshot note above).
  if (realMirrorBindings.length) {
    await replaceMirrorBindings(A, realMirrorBindings.map((b) => ({
      guildId: b.guild_id, forumChannelId: b.forum_channel_id, enabled: b.enabled,
      responderRoleId: b.responder_role_id, attributionMode: (b.attribution_mode as "team" | "collaborator") ?? "team",
      attributionName: b.attribution_name ?? undefined, filter: b.filter ?? {},
    })));
  }

  await clean();
  await superPool.end();
  console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
