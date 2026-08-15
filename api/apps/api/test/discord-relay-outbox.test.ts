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
const mock: MirrorTransport = {
  async listForums() { return []; },
  async listRoles() { return []; },
  async listTextChannels() { return []; },
  async createForumPost() { return null; },
  async createMessageThread() { return null; },
  async postToThread() { return true; },
  async setArchived() { return true; },
  async applyTags() { return true; },
  async react(threadId, messageId, emoji) {
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

  await clean();
  setMirrorTransportForTests(null);
  await superPool.end();
  await relayPool.end();
  await appPool.end();

  if (failures > 0) { console.error(`\nRELAY-OUTBOX: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nRELAY-OUTBOX: all checks green");
}

main().catch((e) => { console.error("relay-outbox seam ERROR", e); process.exit(1); });
