import pg from "pg";
import { appPool, relayPool, withTenant } from "@repo/db";
import { RateLimitError } from "discord.js";
import { deliverDiscordReply, type Sender } from "../src/discord.js";
import { setDiscordSenderForTests } from "../src/discord-gateway.js";
import { deliverRelayNow, drainDiscordRelay, enqueueRelay, purgeFinishedRelays, reconcileReplyStatuses, relayNonce, requeueRepliesRefusedByOlderCode } from "../src/discord-relay-outbox.js";
import { getChannelDriver } from "../src/channels/registry.js";
import { ingestInbound } from "../src/ingest.js";

// Durable Discord replies (deliverDiscordReply): an agent or AI reply goes through the relay outbox, so a failed
// send retries instead of being lost, and messages.delivery_status shows pending → sent / failed.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)

let failures = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${got !== undefined ? ` — got: ${JSON.stringify(got)}` : ""}`); }
}

type Mode = "ok" | "throw" | "ratelimit" | "not-text" | "slow" | "delay";
let mode: Mode = "ok";
const allSends: Array<{ channelId: string; content: string; nonce?: string }> = [];
// Other suites can leave reply rows that this suite's drainer delivers too, so only this suite's channels count.
const sends = {
  get length() { return allSends.filter((x) => x.channelId.startsWith("rdtest-")).length; },
  set length(n: number) { allSends.length = n; },
  at: (i: number) => allSends.filter((x) => x.channelId.startsWith("rdtest-"))[i],
  some: (f: (x: { channelId: string }) => boolean) => allSends.some(f),
  filter: (f: (x: { channelId: string }) => boolean) => allSends.filter(f),
};
const sender: Sender = async (channelId, content, opts) => {
  if (mode === "throw") throw new Error("socket hang up (test)");
  if (mode === "ratelimit") {
    throw new RateLimitError({ global: false, method: "post", url: "", route: "/channels/:id/messages", majorParameter: channelId, hash: "", limit: 1, timeToReset: 0, retryAfter: 600_000, sublimitTimeout: 600_000, scope: "user" });
  }
  if (mode === "not-text") return false;
  if (mode === "slow") await new Promise((r) => setTimeout(r, 4_500));
  if (mode === "delay") await new Promise((r) => setTimeout(r, 1_000));
  allSends.push({ channelId, content, nonce: opts?.nonce });
  return true;
};

let seq = 0;
/** A Discord ticket with one customer message and one stored agent reply. */
async function agentReply(): Promise<{ tenantId: string; ticketId: string; messageId: string; channelId: string }> {
  const channelId = `rdtest-thread-${++seq}`;
  const customer = await ingestInbound({
    tenantId: A, body: "RDTEST question", authorType: "customer", channelType: "discord",
    externalChannelId: channelId, threadingPolicy: "thread", externalThreadId: channelId,
    identity: { externalId: `rdtest-cust-${seq}`, name: "RD Tester" }, idempotencyKey: `rdtest:q:${seq}`, skipAutoreply: true,
  });
  const reply = await ingestInbound({
    tenantId: A, body: "RDTEST answer", authorType: "agent", ticketId: customer.ticketId,
    channelType: "discord", externalChannelId: channelId, idempotencyKey: `rdtest:a:${seq}`,
  });
  return { tenantId: A, ticketId: customer.ticketId, messageId: reply.messageId, channelId };
}

async function deliveryStatus(messageId: string): Promise<string | null> {
  return withTenant(A, async (c) => {
    const r = await c.query("SELECT delivery_status FROM messages WHERE id = $1", [messageId]);
    return (r.rows[0]?.delivery_status as string | null) ?? null;
  });
}

async function relayRow(messageId: string) {
  const r = await relayPool.query(
    "SELECT id, status, attempts, max_attempts, next_attempt_at > now() + interval '590 seconds' AS far_future, next_attempt_at > now() AS future FROM discord_relay_outbox WHERE dedupe_key = $1",
    [`reply:${messageId}`],
  );
  return r.rows[0] as { id: string; status: string; attempts: number; max_attempts: number; far_future: boolean; future: boolean } | undefined;
}
const makeDue = (messageId: string) => relayPool.query("UPDATE discord_relay_outbox SET next_attempt_at = now() WHERE dedupe_key = $1", [`reply:${messageId}`]);

async function main() {
  const superPool = new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432), database: process.env.DB_NAME,
    user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 1,
  });
  const clean = async () => {
    const t = "SELECT id FROM tickets WHERE external_channel_id LIKE 'rdtest-%'";
    await superPool.query(`DELETE FROM discord_relay_outbox WHERE ticket_id IN (${t})`);
    await superPool.query(`DELETE FROM outbox WHERE payload->>'ticketId' IN (SELECT id::text FROM tickets WHERE external_channel_id LIKE 'rdtest-%')`);
    await superPool.query(`DELETE FROM messages WHERE ticket_id IN (${t})`);
    await superPool.query("DELETE FROM tickets WHERE external_channel_id LIKE 'rdtest-%'");
    await superPool.query("DELETE FROM contacts WHERE tenant_id = $1 AND external_id LIKE 'rdtest-%'", [A]);
  };
  await clean();
  setDiscordSenderForTests(sender);

  // ── the first attempt lands ──
  {
    mode = "ok"; sends.length = 0;
    const r = await agentReply();
    const out = await deliverDiscordReply({ ...r }, "RDTEST answer");
    const row = await relayRow(r.messageId);
    check("a reply that lands reports delivered", out.delivered === true && !out.queued);
    check("it was sent to the ticket's channel with the row's nonce", sends.length === 1 && sends.at(0).channelId === r.channelId && sends.at(0).nonce === relayNonce(row!.id), allSends);
    check("delivery_status is sent", (await deliveryStatus(r.messageId)) === "sent");
    check("the relay row is delivered", row?.status === "delivered");
    const ev = await superPool.query(
      "SELECT count(*)::int AS n FROM outbox WHERE event_type = 'ticket.updated' AND payload->>'ticketId' = $1 AND payload->'data'->>'deliveryStatus' = 'sent'",
      [r.ticketId],
    );
    check("a ticket.updated event refreshes the open thread", ev.rows[0].n === 1);

    const again = await deliverDiscordReply({ ...r }, "RDTEST answer");
    check("delivering the same reply again sends nothing new", again.delivered === true && sends.length === 1);
  }

  // ── the first attempt fails, the drainer retries ──
  {
    mode = "throw"; sends.length = 0;
    const r = await agentReply();
    const out = await deliverDiscordReply({ ...r }, "RDTEST answer");
    const row = await relayRow(r.messageId);
    check("a failed first attempt reports queued", out.delivered === false && out.queued === true, out);
    check("delivery_status is pending", (await deliveryStatus(r.messageId)) === "pending");
    check("the row backs off", row?.status === "pending" && row.attempts === 1 && row.future === true, row);
    check("replies get more attempts than mirror relays", row?.max_attempts === 20, row);

    mode = "ok";
    await makeDue(r.messageId);
    await drainDiscordRelay();
    check("the retry delivers it", sends.filter((s) => s.channelId === r.channelId).length === 1 && (await deliveryStatus(r.messageId)) === "sent");
  }

  // ── a rate limit sets the next attempt ──
  {
    mode = "ratelimit";
    const r = await agentReply();
    const out = await deliverDiscordReply({ ...r }, "RDTEST answer");
    check("a rate-limited reply is queued", out.queued === true);
    check("the next attempt waits out the rate limit", (await relayRow(r.messageId))?.far_future === true);
  }

  // ── the retries run out ──
  {
    mode = "throw";
    const r = await agentReply();
    await deliverDiscordReply({ ...r }, "RDTEST answer");
    await relayPool.query("UPDATE discord_relay_outbox SET max_attempts = attempts WHERE dedupe_key = $1", [`reply:${r.messageId}`]);
    await makeDue(r.messageId);
    await drainDiscordRelay();
    check("the row is dead-lettered", (await relayRow(r.messageId))?.status === "failed");
    check("delivery_status is failed", (await deliveryStatus(r.messageId)) === "failed");
  }

  // ── a channel that can't take messages fails at once ──
  {
    mode = "not-text";
    const r = await agentReply();
    const out = await deliverDiscordReply({ ...r }, "RDTEST answer");
    check("a non-text channel fails without retrying", out.delivered === false && !out.queued && (await relayRow(r.messageId))?.status === "failed", out);
    check("and shows as failed", (await deliveryStatus(r.messageId)) === "failed");
  }

  // ── a slow first attempt is reported as queued, then lands ──
  {
    mode = "slow"; sends.length = 0;
    const r = await agentReply();
    const t0 = Date.now();
    const out = await deliverDiscordReply({ ...r }, "RDTEST answer");
    check("the reply request returns within the wait", Date.now() - t0 < 4_000 && out.queued === true, Date.now() - t0);
    await new Promise((res) => setTimeout(res, 2_500));
    check("the slow attempt still delivers it", sends.length === 1 && (await deliveryStatus(r.messageId)) === "sent");
  }

  // ── another drainer claimed the row first: the reply request waits for its attempt ──
  {
    mode = "delay"; sends.length = 0;
    const r = await agentReply();
    const key = `reply:${r.messageId}`;
    await enqueueRelay("reply", A, r.ticketId, key, { messageId: r.messageId, channelId: r.channelId, body: "RDTEST answer" });
    const otherDrainer = drainDiscordRelay();
    await new Promise((res) => setTimeout(res, 200));
    const outcome = await deliverRelayNow(key, 3_000);
    await otherDrainer;
    check("a row delivered by another drainer is reported as delivered", outcome === "delivered" && sends.length === 1, outcome);
  }

  // ── a reply row that older code dead-lettered during a rolling deploy is delivered after all ──
  {
    mode = "ok"; sends.length = 0;
    const r = await agentReply();
    const key = `reply:${r.messageId}`;
    await enqueueRelay("reply", A, r.ticketId, key, { messageId: r.messageId, channelId: r.channelId, body: "RDTEST answer" });
    await relayPool.query("UPDATE discord_relay_outbox SET status = 'failed', last_error = 'unknown relay kind reply' WHERE dedupe_key = $1", [key]);
    await requeueRepliesRefusedByOlderCode({ now: true });
    await drainDiscordRelay();
    check("a reply refused by older code is re-queued and delivered", (await relayRow(r.messageId))?.status === "delivered" && sends.length === 1, await relayRow(r.messageId));
  }

  // ── a reply that reached Discord while its status write failed is reconciled from the outbox ──
  {
    mode = "ok"; sends.length = 0;
    const r = await agentReply();
    const key = `reply:${r.messageId}`;
    await enqueueRelay("reply", A, r.ticketId, key, { messageId: r.messageId, channelId: r.channelId, body: "RDTEST answer" });
    await relayPool.query("UPDATE discord_relay_outbox SET status = 'delivered', delivered_at = now() WHERE dedupe_key = $1", [key]);
    await withTenant(A, (c) => c.query("UPDATE messages SET delivery_status = 'pending' WHERE id = $1", [r.messageId]));
    await reconcileReplyStatuses({ now: true });
    const st = await withTenant(A, (c) => c.query("SELECT delivery_status FROM messages WHERE id = $1", [r.messageId]));
    check("a delivered reply stuck on pending is marked sent", st.rows[0]?.delivery_status === "sent", st.rows[0]);
  }

  // ── finished rows are purged after 30 days, newer ones are kept ──
  {
    const r = await agentReply();
    const oldKey = `reply:${r.messageId}`;
    const recent = await agentReply();
    const recentKey = `reply:${recent.messageId}`;
    await enqueueRelay("reply", A, r.ticketId, oldKey, { messageId: r.messageId, channelId: r.channelId, body: "RDTEST old" });
    await enqueueRelay("reply", A, recent.ticketId, recentKey, { messageId: recent.messageId, channelId: recent.channelId, body: "RDTEST recent" });
    await relayPool.query("UPDATE discord_relay_outbox SET status = 'delivered', updated_at = now() - interval '31 days' WHERE dedupe_key = $1", [oldKey]);
    await relayPool.query("UPDATE discord_relay_outbox SET status = 'failed', updated_at = now() - interval '10 days' WHERE dedupe_key = $1", [recentKey]);
    await purgeFinishedRelays({ now: true });
    check("a finished row older than 30 days is purged", !(await relayRow(r.messageId)));
    check("a newer finished row is kept", (await relayRow(recent.messageId))?.status === "failed");
  }

  // ── no outbox row, so no retry: the one attempt is a direct send ──
  {
    mode = "ok"; sends.length = 0;
    const r = await agentReply();
    // A missing tenant id makes the enqueue fail.
    const out = await deliverDiscordReply({ ...r, tenantId: null as unknown as string }, "RDTEST answer");
    check("a failed enqueue still sends the reply directly", out.delivered === true && sends.length === 1 && !(await relayRow(r.messageId)), out);
  }

  // ── the channel registry: ticket replies are durable, broadcast posts stay direct ──
  {
    mode = "ok"; sends.length = 0;
    const driver = getChannelDriver("discord")!;
    const r = await agentReply();
    await driver.dispatch!({ tenantId: A, channelType: "discord", externalChannelId: r.channelId, subject: "s", ticketId: r.ticketId, messageId: r.messageId }, "RDTEST answer");
    check("a ticket reply goes through the outbox", (await relayRow(r.messageId))?.status === "delivered");
    const direct = await driver.dispatch!({ tenantId: A, channelType: "discord", externalChannelId: "rdtest-broadcast", subject: "s" }, "RDTEST post", { asEmbed: true });
    check("a broadcast post is sent directly", direct.delivered === true && sends.some((s) => s.channelId === "rdtest-broadcast"));
  }

  setDiscordSenderForTests(null);
  await clean();
  await superPool.end();
  await appPool.end();
  await relayPool.end();
  if (failures > 0) {
    console.error(`\nDISCORD-REPLY-DELIVERY: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nDISCORD-REPLY-DELIVERY: all checks green");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
