import pg from "pg";
import { appPool, relayPool } from "@repo/db";
import { ingestInbound } from "../src/ingest.js";
import { listTickets, assignTicket, setTicketStatus, listUsers, type View } from "../src/tickets.js";

// Slice-03 seam gate: whose-turn automation, cross-tenant assignment block,
// View filters, close/reopen — through the same functions the routes call. Exit 1 on any fail.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const B = "22222222-2222-2222-2222-222222222222"; // Globex
const ACME_U1 = "c0000000-0000-0000-0000-000000000001"; // Aleš
const GLOBEX_U = "b0000000-0000-0000-0000-000000000001"; // Mia

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.error(`  FAIL  ${name}`);
  }
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
    await superPool.query("DELETE FROM tickets WHERE subject LIKE 'OPTEST%'"); // cascades messages
    await superPool.query("DELETE FROM outbox WHERE payload->'data'->>'body' LIKE 'OPTEST%'");
  };
  await clean();

  const mk = async (subject: string) =>
    (await ingestInbound({ tenantId: A, body: `${subject} body`, authorType: "customer", subject })).ticketId;
  const whoseTurn = async (id: string) =>
    (await superPool.query("SELECT whose_turn FROM tickets WHERE id=$1", [id])).rows[0].whose_turn;
  const subjectsIn = async (view: View, assigneeId?: string) =>
    (await listTickets(A, view, assigneeId))
      .filter((t) => t.subject.startsWith("OPTEST"))
      .map((t) => t.subject)
      .sort();
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  // build four tickets in distinct states
  const v1 = await mk("OPTEST-V1"); // customer, unassigned  → us
  const v2 = await mk("OPTEST-V2"); // customer, assigned U1  → us
  const v3 = await mk("OPTEST-V3"); // customer + agent reply → customer
  const v4 = await mk("OPTEST-V4"); // customer, then closed

  // 1 — whose-turn automation
  check("customer message sets whose_turn='us' (needs reply)", (await whoseTurn(v1)) === "us");
  await ingestInbound({ tenantId: A, body: "OPTEST-V3 agent reply", authorType: "agent", ticketId: v3 });
  check("agent reply flips whose_turn to 'customer'", (await whoseTurn(v3)) === "customer");

  // 2 — assignment + cross-tenant block
  const asg = await assignTicket(A, v2, ACME_U1);
  check("assign sets assignee_id to a same-tenant user", asg?.assigneeId === ACME_U1);

  let blocked = false;
  try {
    await assignTicket(A, v2, GLOBEX_U); // another tenant's user id
  } catch (e) {
    blocked = (e as { code?: string }).code === "23503";
  }
  check("cross-tenant assignment is blocked (composite FK, 23503)", blocked);
  const stillMine = await superPool.query("SELECT assignee_id FROM tickets WHERE id=$1", [v2]);
  check("blocked assignment left the prior assignee intact", stillMine.rows[0].assignee_id === ACME_U1);

  await setTicketStatus(A, v4, "closed");

  // 3 — Views
  check("View all = open tickets (V1,V2,V3)", eq(await subjectsIn("all"), ["OPTEST-V1", "OPTEST-V2", "OPTEST-V3"]));
  check("View needs_reply = whose_turn us & open (V1,V2)", eq(await subjectsIn("needs_reply"), ["OPTEST-V1", "OPTEST-V2"]));
  check("View unassigned = null assignee & open (V1,V3)", eq(await subjectsIn("unassigned"), ["OPTEST-V1", "OPTEST-V3"]));
  check("View my(Aleš) = assigned to me & open (V2)", eq(await subjectsIn("my", ACME_U1), ["OPTEST-V2"]));
  check("View my with no assignee = empty", eq(await subjectsIn("my"), []));
  check("View closed = status closed (V4)", eq(await subjectsIn("closed"), ["OPTEST-V4"]));

  // 4 — close / reopen lifecycle
  await setTicketStatus(A, v1, "closed");
  check("closing V1 drops it from all", !(await subjectsIn("all")).includes("OPTEST-V1"));
  check("closing V1 adds it to closed", (await subjectsIn("closed")).includes("OPTEST-V1"));
  await setTicketStatus(A, v4, "open");
  check("reopening V4 returns it to all", (await subjectsIn("all")).includes("OPTEST-V4"));

  // 5 — users listing is tenant-scoped
  const acmeUsers = (await listUsers(A)).map((u) => (u as { name: string }).name);
  check("Acme sees its agents (Aleš, Sam)", acmeUsers.includes("Aleš") && acmeUsers.includes("Sam"));
  check("Acme does NOT see Globex's agent (Mia)", !acmeUsers.includes("Mia"));

  // 6 — cross-tenant ticket isolation still holds through the View path
  const globexSees = (await listTickets(B, "all")).filter((t) => t.subject.startsWith("OPTEST"));
  check("Globex sees none of Acme's OPTEST tickets", globexSees.length === 0);

  await clean();
  await superPool.end();
  await appPool.end();
  await relayPool.end();

  if (failures > 0) {
    console.error(`\nOPERATING LAYER: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nOPERATING LAYER: all checks green");
}

main().catch((e) => {
  console.error("operating layer ERROR", e);
  process.exit(1);
});
