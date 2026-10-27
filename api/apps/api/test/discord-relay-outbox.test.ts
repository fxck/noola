import pg from "pg";
import { relayPool, appPool } from "@repo/db";
import { setMirrorTransportForTests } from "../src/discord-mirror.js";
import { enqueueRelay, drainDiscordRelay } from "../src/discord-relay-outbox.js";
import type { MirrorTransport } from "../src/discord-gateway.js";

// Reliability contract for the Discord-relay outbox (0113): every mirror write is durable, logged,
// confirmed on delivery, retried with backoff on failure, and dead-lettered after max attempts. These
// are the guarantees that replace the old fire-and-forget-into-discord.js path, where a degraded
// connection lost writes silently. Uses 'react' relays (no message-row dependency) to isolate the
// outbox mechanics; the happy-path message/note relay is covered in discord-mirror.test.ts.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const TICKET = "dccccccc-0000-4000-8000-00000000d113"; // fixed uuid for this suite's seeded mirror
const THREAD = "reltest-thread-d113";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

// Togglable transport: react() throws when `failing`, otherwise records the call and succeeds.
let failing = false;
const reactCalls: Array<{ threadId: string; messageId: string; emoji: string }> = [];
// postToThread records every call (with its nonce); `postFailOnce` throws on the next call only.
// `syncHangs` makes the forum tag/archive edits never resolve — Discord's thread-edit rate limit.
let postFailOnce = false;
let syncHangs = false;
const postCalls: Array<{ threadId: string; content: string; nonce?: string }> = [];
let onReact: (() => Promise<void>) | null = null;
const mock: MirrorTransport = {
  async listForums() { return []; },
  async listRoles() { return []; },
  async listTextChannels() { return []; },
  async createForumPost() { return null; },
  async createMessageThread() { return null; },
  async postToThread(threadId, content, _files, _mentions, opts) {
    postCalls.push({ threadId, content, nonce: opts?.nonce });
    if (postFailOnce) { postFailOnce = false; throw new Error("socket hang up (test)"); }
    return true;
  },
  async setArchived() { return syncHangs ? new Promise<boolean>(() => {}) : true; },
  async applyTags() { return syncHangs ? new Promise<boolean>(() => {}) : true; },
  async react(threadId, messageId, emoji) {
    if (onReact) await onReact();
    if (failing) throw new Error("discord degraded (test)");
    reactCalls.push({ threadId, messageId, emoji });
    return true;
  },
  async memberRoleIds() { return []; },
};

async function row(dedupe: string): Promise<{ status: string; attempts: number; last_error: string | null; next_future: boolean } | null> {
  const r = await relayPool.query(
    "SELECT status, attempts, last_error, next_attempt_at > now() AS next_future FROM discord_relay_outbox WHERE dedupe_key = $1",
    [dedupe],
  );
  return r.rowCount ? (r.rows[0] as { status: string; attempts: number; last_error: string | null; next_future: boolean }) : null;
}
const makeDue = (dedupe: string) => relayPool.query("UPDATE discord_relay_outbox SET next_attempt_at = now() WHERE dedupe_key = $1", [dedupe]);

async function main() {
  const superPool = new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432), database: process.env.DB_NAME,
    user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 1,
  });
  const seedMirror = () => relayPool.query(
    `INSERT INTO ticket_mirror (tenant_id, ticket_id, binding_id, guild_id, forum_channel_id, post_thread_id)
     VALUES ($1, $2, NULL, 'reltest-guild', 'reltest-forum', $3)
     ON CONFLICT (tenant_id, ticket_id) DO UPDATE SET post_thread_id = EXCLUDED.post_thread_id`,
    [A, TICKET, THREAD],
  );
  const clean = async () => {
    await relayPool.query("DELETE FROM discord_relay_outbox WHERE ticket_id = $1", [TICKET]);
    await relayPool.query("DELETE FROM ticket_mirror WHERE ticket_id = $1", [TICKET]);
  };
  await clean();
  await seedMirror();
  setMirrorTransportForTests(mock);

  // ── idempotency: the same logical write enqueued twice is one row ──────────
  {
    const k = `react:reltest-dm-idem:✅`;
    await enqueueRelay("react", A, TICKET, k, { threadId: THREAD, discordMessageId: "reltest-dm-idem", emoji: "✅" });
    await enqueueRelay("react", A, TICKET, k, { threadId: THREAD, discordMessageId: "reltest-dm-idem", emoji: "✅" });
    const c = await relayPool.query("SELECT count(*)::int AS n FROM discord_relay_outbox WHERE dedupe_key = $1", [k]);
    check("idempotent enqueue — one row for a repeated dedupe key", c.rows[0].n === 1);
  }

  // ── happy path: drain delivers + confirms ─────────────────────────────────
  {
    failing = false; reactCalls.length = 0;
    const k = `react:reltest-dm-ok:✅`;
    await enqueueRelay("react", A, TICKET, k, { threadId: THREAD, discordMessageId: "reltest-dm-ok", emoji: "✅" });
    await drainDiscordRelay();
    check("delivered write performs the Discord react", reactCalls.some((c) => c.messageId === "reltest-dm-ok"));
    const r = await row(k);
    check("delivered row marked 'delivered'", r?.status === "delivered");
  }

  // ── failure: a throwing transport keeps the row pending, backs off, logs ───
  {
    failing = true; reactCalls.length = 0;
    const k = `react:reltest-dm-fail:✅`;
    await enqueueRelay("react", A, TICKET, k, { threadId: THREAD, discordMessageId: "reltest-dm-fail", emoji: "✅" });
    await drainDiscordRelay();
    const r = await row(k);
    check("failed write stays pending (retriable)", r?.status === "pending");
    check("failed write bumped attempts", (r?.attempts ?? 0) === 1);
    check("failed write recorded last_error", !!r?.last_error);
    check("failed write backed off (next_attempt in the future)", r?.next_future === true);

    // ── recovery: once the transport works and it's due again, it delivers ───
    failing = false;
    await makeDue(k);
    await drainDiscordRelay();
    const r2 = await row(k);
    check("recovered write eventually delivered", r2?.status === "delivered");
    check("recovery performed the react", reactCalls.some((c) => c.messageId === "reltest-dm-fail"));
  }

  // ── mirror not ready: retriable, never dead-lettered for a transient gap ───
  {
    failing = false;
    const k = `react:reltest-dm-nomirror:✅`;
    await relayPool.query("DELETE FROM ticket_mirror WHERE ticket_id = $1", [TICKET]); // mirror not created yet
    await enqueueRelay("react", A, TICKET, k, { threadId: THREAD, discordMessageId: "reltest-dm-nomirror", emoji: "✅" });
    await drainDiscordRelay();
    const r = await row(k);
    check("mirror-not-ready stays pending (retries until the post exists)", r?.status === "pending");
    await seedMirror(); // post finishes creating
    await makeDue(k);
    await drainDiscordRelay();
    check("delivers once the mirror is ready", (await row(k))?.status === "delivered");
  }

  // ── dead-letter: give up + mark 'failed' after max_attempts ───────────────
  {
    failing = true;
    const k = `react:reltest-dm-dead:✅`;
    await enqueueRelay("react", A, TICKET, k, { threadId: THREAD, discordMessageId: "reltest-dm-dead", emoji: "✅" });
    // Fast-forward to the retry ceiling so the next failing attempt is terminal.
    await relayPool.query("UPDATE discord_relay_outbox SET attempts = max_attempts, next_attempt_at = now() WHERE dedupe_key = $1", [k]);
    await drainDiscordRelay();
    const r = await row(k);
    check("dead-lettered to 'failed' after max attempts", r?.status === "failed");
    check("dead-letter kept the last error for triage", !!r?.last_error);
  }

  // ── PROD INCIDENT (0119): a relayed message was re-posted on every attempt ─────────────────────────
  // The deliverer awaited the forum tag/archive sync AFTER posting; the sync sat behind Discord's
  // thread-edit rate limit past the deadline, so a delivered message counted as failed and was posted
  // again, 10x. Delivery must succeed on the FIRST attempt no matter how long the sync takes.
  {
    failing = false; syncHangs = true; postCalls.length = 0;
    const msgId = "dccccccc-0000-4000-8000-0000000d1191";
    await superPool.query(
      `INSERT INTO tickets (id, tenant_id, subject, channel_type, status) VALUES ($1, $2, 'reltest incident', 'email', 'open')
       ON CONFLICT (tenant_id, id) DO NOTHING`,
      [TICKET, A],
    );
    await superPool.query(
      `INSERT INTO messages (id, tenant_id, ticket_id, author_type, body) VALUES ($1, $2, $3, 'customer', 'reltest relayed body')
       ON CONFLICT DO NOTHING`,
      [msgId, A, TICKET],
    );
    const k = `message:${msgId}`;
    await enqueueRelay("message", A, TICKET, k, { messageId: msgId });
    const started = Date.now();
    await drainDiscordRelay();
    const r = await row(k);
    check("message relay delivered on the first attempt while the forum sync hangs", r?.status === "delivered" && r?.attempts === 1);
    check("…and posted exactly once", postCalls.filter((c) => c.content.includes("reltest relayed body")).length === 1);
    check("…without waiting on the sync (well under the 20s deadline)", Date.now() - started < 10_000);
    check("relayed post carries a Discord nonce", !!postCalls[0]?.nonce);
    syncHangs = false;
  }

  // ── a retried write reuses the SAME nonce, so Discord collapses a copy that landed late ──────────────
  {
    postCalls.length = 0; postFailOnce = true;
    const k = "note:reltest-note-nonce";
    await enqueueRelay("note", A, TICKET, k, { authorName: "Tester", body: "reltest nonce note" });
    await drainDiscordRelay();
    check("first note attempt failed and stays pending", (await row(k))?.status === "pending");
    await makeDue(k);
    await drainDiscordRelay();
    check("second attempt delivered", (await row(k))?.status === "delivered");
    const nonces = postCalls.filter((c) => c.content.includes("reltest nonce note")).map((c) => c.nonce);
    check("both attempts sent the same nonce", nonces.length === 2 && !!nonces[0] && nonces[0] === nonces[1]);
  }

  // ── fencing: a drainer whose lease was taken over can't record the outcome ────────────────────────────
  {
    failing = false;
    const k = "react:reltest-dm-fence:✅";
    await enqueueRelay("react", A, TICKET, k, { threadId: THREAD, discordMessageId: "reltest-dm-fence", emoji: "✅" });
    // While our delivery is in flight, another drainer claims the row (fresh lease token).
    onReact = async () => {
      await relayPool.query("UPDATE discord_relay_outbox SET lease_token = gen_random_uuid() WHERE dedupe_key = $1", [k]);
    };
    await drainDiscordRelay();
    onReact = null;
    check("lost-lease drainer did not mark the row delivered", (await row(k))?.status === "pending");
  }

  // ── a triage ack is re-applied on each gesture (reapply resets a finished row) ────────────────────────
  {
    failing = false; reactCalls.length = 0;
    const k = "react:reltest-dm-reapply:🆗";
    const payload = { threadId: THREAD, discordMessageId: "reltest-dm-reapply", emoji: "🆗" };
    await enqueueRelay("react", A, TICKET, k, payload, { reapply: true });
    await drainDiscordRelay();
    check("ack delivered", (await row(k))?.status === "delivered");
    await enqueueRelay("react", A, TICKET, k, payload, { reapply: true });
    check("re-enqueued ack is pending again", (await row(k))?.status === "pending");
    await drainDiscordRelay();
    check("re-applied ack reached Discord twice", reactCalls.filter((c) => c.messageId === "reltest-dm-reapply").length === 2);
    // A message is NEVER re-sent by a repeated enqueue.
    const mk = "message:dccccccc-0000-4000-8000-0000000d1191";
    await enqueueRelay("message", A, TICKET, mk, { messageId: "dccccccc-0000-4000-8000-0000000d1191" }, { reapply: true });
    check("reapply is ignored for messages", (await row(mk))?.status === "delivered");
  }

  await superPool.query("DELETE FROM messages WHERE ticket_id = $1", [TICKET]);
  await superPool.query("DELETE FROM tickets WHERE id = $1", [TICKET]);
  await clean();
  setMirrorTransportForTests(null);
  await superPool.end();
  await relayPool.end();
  await appPool.end();

  if (failures > 0) { console.error(`\nRELAY-OUTBOX: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nRELAY-OUTBOX: all checks green");
}

main().catch((e) => { console.error("relay-outbox seam ERROR", e); process.exit(1); });
