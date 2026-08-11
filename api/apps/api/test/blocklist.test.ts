import pg from "pg";

// Sender blocklist + ticket-spam soft-hide. Exercises the enforcement lib (block/list/isBlocked/
// unblock for both address + domain scopes), the inbound guard (a blocked sender drops to null before
// any ticket/lead), and the spam view filter (setTicketSpam hides a ticket from every view except the
// dedicated Spam view, and unspam restores it). DB-backed, on the dedicated TestCo tenant.

process.env.MODEL_KEY_SECRET = process.env.MODEL_KEY_SECRET || "test-model-key-secret-🔑";

const { blockSender, listBlockedSenders, isSenderBlocked, unblockSender, unblockByHandle, handleDomain } =
  await import("../src/blocklist.js");
const { setTicketSpam, listTickets } = await import("../src/tickets.js");
const { handleInboundEmail } = await import("../src/email.js");
const { withTenant } = await import("@repo/db");

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
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
    await superPool.query("DELETE FROM blocked_senders WHERE tenant_id = $1", [A]);
    await superPool.query("DELETE FROM tickets WHERE tenant_id = $1 AND subject LIKE 'BLOCKLIST-TEST%'", [A]);
  };
  await clean();

  try {
    // ---- handleDomain helper ----
    check("handleDomain extracts the domain", handleDomain("Spammer@Spam.Example") === "spam.example");
    check("handleDomain null without @", handleDomain("nodomain") === null);

    // ---- exact-address block ----
    await blockSender(A, { handle: "Vlastimila@Spam.Example", reason: "marked spam" });
    check("exact block matches the address (case-insensitive)", await isSenderBlocked(A, "email", "vlastimila@spam.example"));
    check("exact block matches with different casing", await isSenderBlocked(A, "email", "VLASTIMILA@SPAM.EXAMPLE"));
    check("exact block does NOT match a sibling local-part", !(await isSenderBlocked(A, "email", "someone@spam.example")));
    check("exact block does NOT leak to another channel", !(await isSenderBlocked(A, "discord", "vlastimila@spam.example")));

    // ---- domain block (accepts a full address, stores the domain) ----
    await blockSender(A, { handle: "anyone@junk.example", scope: "domain" });
    check("domain block matches any local-part on the domain", await isSenderBlocked(A, "email", "whoever@junk.example"));
    check("domain block matches a second local-part", await isSenderBlocked(A, "email", "another@junk.example"));
    check("domain block does NOT match a different domain", !(await isSenderBlocked(A, "email", "person@other.example")));

    // ---- listing + idempotent re-block ----
    const before = await listBlockedSenders(A);
    check("list returns both blocks", before.length === 2);
    await blockSender(A, { handle: "vlastimila@spam.example", reason: "again" }); // same (channel,scope,handle)
    const after = await listBlockedSenders(A);
    check("re-blocking the same sender is idempotent (no dup row)", after.length === 2);

    // ---- inbound guard: a blocked sender drops to null (no ticket/lead) ----
    const dropped = await handleInboundEmail(
      { to: "support@testco.example", from: "vlastimila@spam.example", subject: "buy a wikipedia page", body: "spam" },
      { tenantId: A },
    );
    check("handleInboundEmail returns null for a blocked sender", dropped === null);

    // ---- unblock by handle (the unspam path) clears the exact block ----
    const removed = await unblockByHandle(A, "email", "vlastimila@spam.example");
    check("unblockByHandle removes the exact block", removed >= 1);
    check("sender is no longer blocked after unblock", !(await isSenderBlocked(A, "email", "vlastimila@spam.example")));

    // ---- unblock by id ----
    const remaining = await listBlockedSenders(A);
    const domainRow = remaining.find((b) => b.scope === "domain");
    check("domain block still present before id-unblock", !!domainRow);
    if (domainRow) {
      const gone = await unblockSender(A, domainRow.id);
      check("unblockSender by id returns true", gone === true);
      check("domain sender no longer blocked", !(await isSenderBlocked(A, "email", "whoever@junk.example")));
    }

    // ---- spam soft-hide: a ticket leaves every view except Spam, and unspam restores it ----
    const ticketId = await withTenant(A, async (c) => {
      const r = await c.query(
        "INSERT INTO tickets (tenant_id, subject, channel_type) VALUES (current_tenant(), 'BLOCKLIST-TEST ticket', 'email') RETURNING id",
      );
      return r.rows[0].id as string;
    });
    const inAll = async () => (await listTickets(A, "all")).some((t) => (t as { id: string }).id === ticketId);
    const inSpam = async () => (await listTickets(A, "spam")).some((t) => (t as { id: string }).id === ticketId);

    check("fresh ticket shows in the All view", await inAll());
    check("fresh ticket is NOT in the Spam view", !(await inSpam()));

    const spammed = await setTicketSpam(A, ticketId, true);
    check("setTicketSpam returns the ticket", spammed?.ticketId === ticketId);
    check("spammed ticket drops out of the All view", !(await inAll()));
    check("spammed ticket appears in the Spam view", await inSpam());

    await setTicketSpam(A, ticketId, false);
    check("unspam restores the ticket to the All view", await inAll());
    check("restored ticket leaves the Spam view", !(await inSpam()));

    await clean();
  } finally {
    await superPool.end();
  }

  if (failures > 0) { console.error(`\nBLOCKLIST: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nBLOCKLIST: all checks green");
}

main().catch((e) => { console.error("blocklist seam ERROR", e); process.exit(1); });
