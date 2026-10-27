import pg from "pg";

// Ticket participants + the Discord notification plumbing behind assignee/participant @pings.
// Covers: participants add (idempotent) / list / remove; the seat→Discord reverse resolver
// (discordIdForSeat); the shared markConversationSpam helper (used by both the web route and the 🚫
// mirror reaction); and the 🚫 reaction mapping. DB-backed, on the dedicated TestCo tenant.

process.env.MODEL_KEY_SECRET = process.env.MODEL_KEY_SECRET || "test-model-key-secret-🔑";

const { listParticipants, addParticipant, removeParticipant } = await import("../src/participants.js");
const { discordIdForSeat, resolveTeammate, upsertAgentChannelIdentity, removeAgentChannelIdentity } =
  await import("../src/discord-classify.js");
const { markConversationSpam, unmarkConversationSpam } = await import("../src/spam.js");
const { listTickets } = await import("../src/tickets.js");
const { canonicalEmojiName, DEFAULT_REACTION_MAP } = await import("../src/classification.js");
const { withTenant } = await import("@repo/db");

const A = "33333333-3333-3333-3333-333333333333"; // TestCo

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

async function main() {
  const superPool = new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432), database: process.env.DB_NAME,
    user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 1,
  });
  const clean = async () => {
    await superPool.query("DELETE FROM tickets WHERE tenant_id = $1 AND subject LIKE 'PARTICIPANTS-TEST%'", [A]);
  };
  await clean();

  try {
    // A real user + ticket in TestCo (seeded agents exist).
    const userId = await withTenant(A, async (c) => (await c.query("SELECT id FROM users LIMIT 1")).rows[0].id as string);
    const ticketId = await withTenant(A, async (c) =>
      (await c.query("INSERT INTO tickets (tenant_id, subject, channel_type) VALUES (current_tenant(), 'PARTICIPANTS-TEST t', 'email') RETURNING id")).rows[0].id as string,
    );

    // ---- 🚫 reaction mapping (pure) ----
    check("🚫 canonicalizes to no_entry_sign", canonicalEmojiName("🚫") === "no_entry_sign");
    check("default reaction map routes no_entry_sign → spam",
      DEFAULT_REACTION_MAP.some((e) => e.emoji === "no_entry_sign" && e.action === "spam"));

    // ---- participants add / list / idempotency / remove ----
    const first = await addParticipant(A, ticketId, userId);
    check("addParticipant returns the participant", first?.participant.userId === userId);
    check("first add reports added=true", first?.added === true);
    check("participant carries a name from users", first?.participant.name !== undefined);

    const again = await addParticipant(A, ticketId, userId);
    check("re-adding is idempotent (added=false)", again?.added === false);

    const list = await listParticipants(A, ticketId);
    check("listParticipants returns exactly one row", list.length === 1 && list[0].userId === userId);

    const badTicket = await addParticipant(A, "00000000-0000-0000-0000-000000000000", userId);
    check("adding to a nonexistent ticket returns null", badTicket === null);

    const removed = await removeParticipant(A, ticketId, userId);
    check("removeParticipant returns true", removed === true);
    check("participant list empty after remove", (await listParticipants(A, ticketId)).length === 0);

    // ---- seat → Discord reverse resolver ----
    await removeAgentChannelIdentity(A, userId).catch(() => {});
    check("no Discord id before mapping", (await discordIdForSeat(A, userId)) === null);
    await upsertAgentChannelIdentity(A, userId, "discord-user-9001");
    check("discordIdForSeat returns the mapped id", (await discordIdForSeat(A, userId)) === "discord-user-9001");
    check("resolveTeammate is the inverse", (await resolveTeammate(A, "discord-user-9001")) === userId);
    await removeAgentChannelIdentity(A, userId);
    check("discordIdForSeat null after unmapping", (await discordIdForSeat(A, userId)) === null);

    // ---- shared markConversationSpam hides + unspam restores ----
    const inAll = async () => (await listTickets(A, "all")).some((t) => (t as { id: string }).id === ticketId);
    const spammed = await markConversationSpam(A, ticketId, { block: false, dropLead: false });
    check("markConversationSpam returns the ticket", spammed?.ticketId === ticketId);
    check("spammed ticket leaves the All view", !(await inAll()));
    await unmarkConversationSpam(A, ticketId);
    check("unmarkConversationSpam restores it", await inAll());

    await clean();
  } finally {
    await superPool.end();
  }

  if (failures > 0) { console.error(`\nPARTICIPANTS: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nPARTICIPANTS: all checks green");
}

main().catch((e) => { console.error("participants seam ERROR", e); process.exit(1); });
