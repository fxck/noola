import pg from "pg";
import { appPool, relayPool, withTenant } from "@repo/db";
import { handleThreadUpdate, linkGuild } from "../src/discord.js";
import { onTicketClosed, setMirrorTransportForTests } from "../src/discord-mirror.js";
import { setTicketStatus } from "../src/tickets.js";
import type { MirrorTransport } from "../src/discord-gateway.js";

// Closes that start on Discord, and how they're reflected back (prod hardening, 2026-09):
//  • a thread update closes an intake ticket only on a TRANSITION — our own writes echo back as thread
//    updates, and reacting to the current state re-closed a ticket reopened in Noola as soon as an agent
//    reply unarchived its (still solved-tagged) thread;
//  • a teammate's ✅ on a customer-opened thread is reflected back (notice + archive) — only closes the
//    thread itself already shows (archived/locked/solved/deleted) skip the write-back;
//  • setTicketStatus(onlyIfChanged) reports a no-op transition, so a re-delivered gesture emits once.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const GUILD = "INTAKECLOSE-guild";
const THREAD = "intakeclose-thread-1";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

const calls: Array<{ fn: string; args: unknown[] }> = [];
const archived = new Map<string, boolean>();
const mock: MirrorTransport = {
  async listForums() { return []; },
  async listRoles() { return []; },
  async listTextChannels() { return []; },
  async createForumPost() { return null; },
  async createMessageThread() { return null; },
  async postToThread(...args) { calls.push({ fn: "postToThread", args }); return true; },
  async setArchived(threadId, value) { calls.push({ fn: "setArchived", args: [threadId, value] }); archived.set(threadId, value); return true; },
  async applyTags(...args) { calls.push({ fn: "applyTags", args }); return true; },
  async threadArchived(threadId) { return archived.get(threadId) ?? false; },
  async react(...args) { calls.push({ fn: "react", args }); return true; },
  async memberRoleIds() { return []; },
};

async function main() {
  const superPool = new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432), database: process.env.DB_NAME,
    user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 1,
  });
  const clean = async () => {
    await superPool.query("DELETE FROM tickets WHERE tenant_id = $1 AND external_thread_id = $2", [A, THREAD]);
    await relayPool.query("DELETE FROM discord_links WHERE guild_id = $1", [GUILD]);
  };
  await clean();
  await linkGuild(GUILD, A);
  const seeded = await superPool.query(
    `INSERT INTO tickets (tenant_id, subject, channel_type, external_channel_id, external_thread_id, external_guild_id, status)
     VALUES ($1, 'INTAKECLOSE thread', 'discord', $2, $2, $3, 'open') RETURNING id`,
    [A, THREAD, GUILD],
  );
  const ticketId = seeded.rows[0].id as string;
  const status = async () =>
    (await withTenant(A, (c) => c.query("SELECT status FROM tickets WHERE id = $1", [ticketId]))).rows[0].status as string;
  const reopen = () => superPool.query("UPDATE tickets SET status = 'open', status_category = 'open', closed_at = NULL WHERE id = $1", [ticketId]);

  // ── transitions ────────────────────────────────────────────────────────────
  await handleThreadUpdate(GUILD, THREAD, { archived: true }, { archived: false });
  check("thread archived (transition) closes the intake ticket", (await status()) === "closed");

  await reopen();
  // Echo after a Noola-side reopen: an agent reply unarchived the thread; the solved tag was already on.
  await handleThreadUpdate(GUILD, THREAD, { archived: false, appliedTagNames: ["Solved"] }, { archived: true, appliedTagNames: ["Solved"] });
  check("unarchive echo with an already-present solved tag does NOT re-close", (await status()) === "open");

  await handleThreadUpdate(GUILD, THREAD, { archived: false, appliedTagNames: ["Solved"] }, { archived: false, appliedTagNames: [] });
  check("a solved tag being ADDED closes", (await status()) === "closed");

  await reopen();
  await handleThreadUpdate(GUILD, THREAD, { locked: true }, null);
  check("unknown previous state keeps the old behavior (locked closes)", (await status()) === "closed");

  // ── idempotent status transitions ──────────────────────────────────────────
  await reopen();
  const first = await setTicketStatus(A, ticketId, "closed", { onlyIfChanged: true });
  const second = await setTicketStatus(A, ticketId, "closed", { onlyIfChanged: true });
  check("onlyIfChanged: first close reports the change", first !== null);
  check("onlyIfChanged: repeated close is a no-op (null)", second === null);
  const plain = await setTicketStatus(A, ticketId, "closed");
  check("default setTicketStatus is unchanged (always returns the row)", plain !== null);

  // ── write-back of Discord-originated closes ────────────────────────────────
  setMirrorTransportForTests(mock);
  calls.length = 0; archived.set(THREAD, false);
  await onTicketClosed(A, ticketId, { source: "discord", closeReason: "discord_reaction" });
  check("✅ reaction close is reflected: notice posted to the thread", calls.some((c) => c.fn === "postToThread" && c.args[0] === THREAD));
  check("✅ reaction close is reflected: thread archived", archived.get(THREAD) === true);

  calls.length = 0; archived.set(THREAD, true);
  await onTicketClosed(A, ticketId, { source: "discord", closeReason: "discord_archived" });
  check("a close the thread already shows writes nothing back", calls.length === 0);

  setMirrorTransportForTests(null);
  await clean();
  await superPool.end();
  await relayPool.end();
  await appPool.end();
  if (failures > 0) { console.error(`\nINTAKE-CLOSE: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nINTAKE-CLOSE: all checks green");
}

main().catch((e) => { console.error("intake-close ERROR", e); process.exit(1); });
