import pg from "pg";
import { withTenant } from "@repo/db";
import {
  handleInboundMessage, linkGuild,
  listDiscordChannelBindings, replaceDiscordChannelBindings,
  setDiscordChannelAccount, listDiscordChannelAccounts, applyDiscordChannelAccount,
  type InboundDiscordMessage,
} from "../src/discord.js";
import { setMirrorTransportForTests } from "../src/discord-mirror.js";
import type { MirrorTransport } from "../src/discord-gateway.js";

// VIP private Discord channels gate (D5): thread-per-message bindings — each top-level CUSTOMER
// message mints a NEW ticket with a bot-anchored thread as its key; in-thread follow-ups ride the
// existing thread=ticket path onto the SAME ticket; top-level agent chatter never mints tickets;
// thread-anchor failure degrades to message-id keying; channel→company account rollup attributes
// contacts. Mock transport, VIPTEST/viptest- prefixed data on the shared dev/stage DB.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const GUILD = "VIPTEST-guild";
const CHANNEL = "viptest-vip-channel";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

let threadSeq = 0;
let failThreadCreate = false;
const threadCalls: { channelId: string; messageId: string; name: string }[] = [];
const mock: MirrorTransport = {
  async listForums() { return []; },
  async listRoles() { return []; },
  async listTextChannels() { return [{ id: CHANNEL, name: "acme-vip" }]; },
  async createForumPost() { return null; },
  async createMessageThread(channelId, messageId, name) {
    threadCalls.push({ channelId, messageId, name });
    if (failThreadCreate) return null;
    return { threadId: `viptest-thread-${++threadSeq}` };
  },
  async postToThread() { return true; },
  async setArchived() { return true; },
  async applyTags() { return true; },
  async react() { return true; },
  async memberRoleIds() { return []; },
};

function topLevel(over: Partial<InboundDiscordMessage> & { discordMessageId: string; authorId: string }): InboundDiscordMessage {
  return {
    guildId: GUILD,
    channelId: CHANNEL,
    content: "VIPTEST we hit a problem",
    threadKind: "channel",
    authorDisplayName: "Vip Customer",
    ...over,
  };
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
    const t = "SELECT id FROM tickets WHERE external_guild_id = 'VIPTEST-guild'";
    await superPool.query(`DELETE FROM messages WHERE ticket_id IN (${t})`);
    await superPool.query(`DELETE FROM tickets WHERE external_guild_id = 'VIPTEST-guild'`);
    await superPool.query(`DELETE FROM discord_channel_bindings WHERE guild_id = $1`, [GUILD]);
    await superPool.query(`DELETE FROM discord_channel_accounts WHERE guild_id = $1`, [GUILD]);
    await superPool.query(`DELETE FROM discord_links WHERE guild_id = $1`, [GUILD]);
    // contacts BEFORE companies: the composite (tenant_id, company_id) FK is ON DELETE SET NULL,
    // which nulls tenant_id too — deleting the company first violates contacts' NOT NULL.
    await superPool.query(`DELETE FROM contacts WHERE tenant_id = $1 AND name LIKE 'Vip Customer%'`, [A]);
    await superPool.query(`DELETE FROM companies WHERE tenant_id = $1 AND name = 'VIPTEST Corp'`, [A]);
  };
  await clean();
  setMirrorTransportForTests(mock);
  await linkGuild(GUILD, A);

  // Snapshot the tenant's REAL channel bindings — replaceDiscordChannelBindings is a tenant-wide
  // full replace on the SHARED demo DB; without restore the suite deletes the owner's live
  // config (vip channel + forum intake). Restored at the end.
  const realChannelBindings = await listDiscordChannelBindings(A);

  // ── bindings management ─────────────────────────────────────────────────────
  const saved = await replaceDiscordChannelBindings(A, [
    { guildId: GUILD, channelId: CHANNEL, mode: "staffed", requireThread: true, threadPerMessage: true },
  ]);
  check("binding saved with thread_per_message", saved.length === 1 && saved[0].thread_per_message === true);
  const listed = await listDiscordChannelBindings(A);
  check("bindings listing scoped to tenant", listed.some((b) => b.channel_id === CHANNEL));

  // ── thread-per-message: each top-level customer message = a new ticket ─────
  const r1 = await handleInboundMessage(topLevel({ discordMessageId: "viptest-m1", authorId: "viptest-user-1" }));
  check("first top-level message mints a ticket", !!r1 && r1.ticketCreated);
  check("bot anchored a thread on the message", threadCalls.length === 1 && threadCalls[0].messageId === "viptest-m1");
  const t1 = r1!.ticketId;
  const t1row = await withTenant(A, async (c) => (await c.query("SELECT external_thread_id, external_parent_id FROM tickets WHERE id = $1", [t1])).rows[0]);
  check("ticket keyed on the anchored thread", t1row.external_thread_id === "viptest-thread-1" && t1row.external_parent_id === CHANNEL);

  const r2 = await handleInboundMessage(topLevel({ discordMessageId: "viptest-m2", authorId: "viptest-user-1", content: "VIPTEST another separate issue" }));
  check("second top-level message mints a SECOND ticket", !!r2 && r2.ticketCreated && r2.ticketId !== t1);

  // In-thread follow-up rides the normal thread path onto the SAME ticket.
  const r3 = await handleInboundMessage({
    guildId: GUILD, channelId: "viptest-thread-1", threadId: "viptest-thread-1", parentId: CHANNEL,
    threadKind: "text_thread", content: "VIPTEST follow-up detail",
    discordMessageId: "viptest-m3", authorId: "viptest-user-1", authorDisplayName: "Vip Customer",
  });
  check("in-thread follow-up lands on the SAME ticket", !!r3 && r3.ticketId === t1 && !r3.ticketCreated);

  // Replay of the same top-level message dedupes (idempotency key).
  const replay = await handleInboundMessage(topLevel({ discordMessageId: "viptest-m1", authorId: "viptest-user-1" }));
  check("top-level redelivery dedupes onto ticket 1", !!replay && replay.replay && replay.ticketId === t1);

  // Top-level agent chatter never mints a ticket (team_role classified).
  await superPool.query(
    `UPDATE discord_links SET team_role_ids = '["viptest-team-role"]'::jsonb WHERE guild_id = $1`, [GUILD]);
  const agent = await handleInboundMessage(topLevel({
    discordMessageId: "viptest-m4", authorId: "viptest-agent-1", roleIds: ["viptest-team-role"],
    authorDisplayName: "Team Member", content: "VIPTEST agent top-level chatter",
  }));
  check("top-level agent message is ignored", agent === null);

  // Bot messages never ingest.
  const bot = await handleInboundMessage(topLevel({ discordMessageId: "viptest-m5", authorId: "viptest-bot", isBotOrWebhook: true }));
  check("bot message ignored", bot === null);

  // Thread-anchor failure degrades to message-id keying (still one ticket per message).
  failThreadCreate = true;
  const r6 = await handleInboundMessage(topLevel({ discordMessageId: "viptest-m6", authorId: "viptest-user-1", content: "VIPTEST perms failure case" }));
  failThreadCreate = false;
  const t6row = await withTenant(A, async (c) => (await c.query("SELECT external_thread_id FROM tickets WHERE id = $1", [r6!.ticketId])).rows[0]);
  check("anchor failure falls back to message-id keying", !!r6 && r6.ticketCreated && t6row.external_thread_id === "viptest-m6");

  // ── channel → company rollup ────────────────────────────────────────────────
  const companyId = await withTenant(A, async (c) => {
    const r = await c.query("INSERT INTO companies (tenant_id, name) VALUES (current_tenant(), 'VIPTEST Corp') RETURNING id");
    return r.rows[0].id as string;
  });
  await setDiscordChannelAccount(A, GUILD, CHANNEL, companyId);
  check("account binding listed", (await listDiscordChannelAccounts(A)).some((a) => a.channel_id === CHANNEL && a.company_id === companyId));

  const r7 = await handleInboundMessage(topLevel({ discordMessageId: "viptest-m7", authorId: "viptest-user-2", authorDisplayName: "Vip Customer Two", content: "VIPTEST from a second person" }));
  check("new contact in the bound channel mints its ticket", !!r7 && r7.ticketCreated);
  const contactCompany = await withTenant(A, async (c) =>
    (await c.query("SELECT company_id FROM contacts WHERE id = $1", [r7!.contactId])).rows[0].company_id as string | null);
  check("contact rolled up to the channel's company", contactCompany === companyId);

  // In-thread rollup keys on the PARENT channel.
  const contact3 = await withTenant(A, async (c) => {
    const r = await c.query("INSERT INTO contacts (tenant_id, name) VALUES (current_tenant(), 'Vip Customer Three') RETURNING id");
    return r.rows[0].id as string;
  });
  await applyDiscordChannelAccount(A, GUILD, CHANNEL, contact3);
  const c3 = await withTenant(A, async (c) => (await c.query("SELECT company_id FROM contacts WHERE id = $1", [contact3])).rows[0].company_id as string | null);
  check("applyDiscordChannelAccount attributes an unattributed contact", c3 === companyId);

  // Removing the binding returns the channel to unmonitored.
  await replaceDiscordChannelBindings(A, []);
  const gone = await handleInboundMessage(topLevel({ discordMessageId: "viptest-m8", authorId: "viptest-user-1" }));
  check("unbinding stops ingestion", gone === null);

  // Restore the owner's real bindings (see snapshot note above).
  if (realChannelBindings.length) {
    await replaceDiscordChannelBindings(A, realChannelBindings.map((b) => ({
      guildId: b.guild_id, channelId: b.channel_id, kind: b.kind as "text" | "forum" | undefined,
      mode: b.mode, requireThread: b.require_thread, threadPerMessage: b.thread_per_message,
      autoreplyMode: b.autoreply_mode,
    })));
  }

  await clean();
  await superPool.end();
  console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
