import Fastify from "fastify";
import pg from "pg";
import { appPool, relayPool } from "@repo/db";
import { ingestInbound } from "../src/ingest.js";
import { listTickets, assignTicket, setTicketStatus, setTicketSpam, listUsers, type View } from "../src/tickets.js";
import { unreadTicketIds } from "../src/reads.js";
import ticketRoutes from "../src/routes/tickets.js";

// Slice-03 seam gate: whose-turn automation, cross-tenant assignment block,
// View filters, close/reopen — through the same functions the routes call. Exit 1 on any fail.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const B = "22222222-2222-2222-2222-222222222222"; // Globex
const TESTCO_U1 = "c0000000-0000-0000-0000-000000000001"; // Tess
const TESTCO_U2 = "c0000000-0000-0000-0000-000000000002"; // Tom
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
  const asg = await assignTicket(A, v2, TESTCO_U1);
  check("assign sets assignee_id to a same-tenant user", asg?.assigneeId === TESTCO_U1);

  let blocked = false;
  try {
    await assignTicket(A, v2, GLOBEX_U); // another tenant's user id
  } catch (e) {
    blocked = (e as { code?: string }).code === "23503";
  }
  check("cross-tenant assignment is blocked (composite FK, 23503)", blocked);
  const stillMine = await superPool.query("SELECT assignee_id FROM tickets WHERE id=$1", [v2]);
  check("blocked assignment left the prior assignee intact", stillMine.rows[0].assignee_id === TESTCO_U1);

  await setTicketStatus(A, v4, "closed");

  // 3 — Views
  check("View all = open tickets (V1,V2,V3)", eq(await subjectsIn("all"), ["OPTEST-V1", "OPTEST-V2", "OPTEST-V3"]));
  check("View needs_reply = whose_turn us & open (V1,V2)", eq(await subjectsIn("needs_reply"), ["OPTEST-V1", "OPTEST-V2"]));
  check("View unassigned = null assignee & open (V1,V3)", eq(await subjectsIn("unassigned"), ["OPTEST-V1", "OPTEST-V3"]));
  check("View my(Tess) = assigned to me & open (V2)", eq(await subjectsIn("my", TESTCO_U1), ["OPTEST-V2"]));
  check("View my with no assignee = empty", eq(await subjectsIn("my"), []));
  check("View closed = status closed (V4)", eq(await subjectsIn("closed"), ["OPTEST-V4"]));

  // 4 — close / reopen lifecycle
  await setTicketStatus(A, v1, "closed");
  check("closing V1 drops it from all", !(await subjectsIn("all")).includes("OPTEST-V1"));
  check("closing V1 adds it to closed", (await subjectsIn("closed")).includes("OPTEST-V1"));
  await setTicketStatus(A, v4, "open");
  check("reopening V4 returns it to all", (await subjectsIn("all")).includes("OPTEST-V4"));

  // 5 — users listing is tenant-scoped
  const testcoUsers = (await listUsers(A)).map((u) => (u as { name: string }).name);
  check("TestCo sees its agents (Tess, Tom)", testcoUsers.includes("Tess") && testcoUsers.includes("Tom"));
  check("TestCo does NOT see Globex's agent (Mia) or Acme's (Aleš)", !testcoUsers.includes("Mia") && !testcoUsers.includes("Aleš"));

  // 6 — cross-tenant ticket isolation still holds through the View path
  const globexSees = (await listTickets(B, "all")).filter((t) => t.subject.startsWith("OPTEST"));
  check("Globex sees none of TestCo's OPTEST tickets", globexSees.length === 0);

  // 7 — the tickets table lists spam only when asked, whatever the spam ticket's status
  const app = Fastify();
  let asUser = TESTCO_U1;
  app.addHook("onRequest", async (req) => {
    (req as unknown as { session: unknown }).session = { userId: asUser, tenantId: A, role: "agent", email: "t@example.invalid", name: "T" };
  });
  await app.register(ticketRoutes);
  const tableSubjects = async (status: string) => {
    const res = await app.inject({ method: "GET", url: `/tickets?table=1&status=${status}&q=OPTEST&limit=100` });
    return (res.json().tickets as { subject: string }[]).map((t) => t.subject).sort();
  };
  const v5 = await mk("OPTEST-V5");
  await setTicketSpam(A, v5, true);
  await setTicketStatus(A, v5, "closed");
  check("table status=spam lists only the spam ticket (V5, closed)", eq(await tableSubjects("spam"), ["OPTEST-V5"]));
  check("table status=all hides spam", !(await tableSubjects("all")).includes("OPTEST-V5"));
  check("table status=closed hides spam", !(await tableSubjects("closed")).includes("OPTEST-V5"));

  // 8 — mark all as read covers exactly the view's tickets, for the calling agent only
  const subjectOf: Record<string, string> = { [v1]: "OPTEST-V1", [v2]: "OPTEST-V2", [v3]: "OPTEST-V3", [v4]: "OPTEST-V4", [v5]: "OPTEST-V5" };
  const readBy = async (userId: string) =>
    (await superPool.query("SELECT ticket_id FROM ticket_reads WHERE user_id = $1 AND ticket_id = ANY($2::uuid[])", [userId, Object.keys(subjectOf)]))
      .rows.map((r) => subjectOf[r.ticket_id as string]).sort();
  const readAll = (body: unknown) => app.inject({ method: "POST", url: "/tickets/read-all", payload: body as object });

  const myRes = await readAll({ scope: "view", view: "my" });
  check("read-all view=my succeeds", myRes.statusCode === 200 && typeof myRes.json().marked === "number");
  check("read-all view=my marks only Tess's ticket (V2)", eq(await readBy(TESTCO_U1), ["OPTEST-V2"]));
  check("read-all as Tess leaves Tom's read state untouched", eq(await readBy(TESTCO_U2), []));
  check("V2 drops out of Tess's unread set", !(await unreadTicketIds(A, TESTCO_U1)).includes(v2));
  const again = await readAll({ scope: "view", view: "my" });
  check("a second read-all marks nothing, because only unread tickets count", again.json().marked === 0, again.json());

  asUser = TESTCO_U2;
  await readAll({ scope: "table", status: "open", q: "OPTEST" });
  check("read-all table status=open marks the open non-spam tickets for Tom (V2,V3,V4)", eq(await readBy(TESTCO_U2), ["OPTEST-V2", "OPTEST-V3", "OPTEST-V4"]));
  check("Tom's read-all leaves Tess's read state as it was", eq(await readBy(TESTCO_U1), ["OPTEST-V2"]));

  asUser = TESTCO_U1;
  await readAll({ scope: "table", status: "spam", q: "OPTEST" });
  check("read-all table status=spam marks only the spam ticket (V5)", eq(await readBy(TESTCO_U1), ["OPTEST-V2", "OPTEST-V5"]));
  const approvalRes = await readAll({ scope: "view", view: "approval" });
  check("read-all view=approval runs (no pending drafts on OPTEST tickets)", approvalRes.statusCode === 200 && eq(await readBy(TESTCO_U1), ["OPTEST-V2", "OPTEST-V5"]));
  const laneRes = await readAll({ scope: "view", view: "all", teamId: "00000000-0000-4000-8000-000000000000" });
  check("read-all in an empty team lane marks nothing", laneRes.statusCode === 200 && laneRes.json().marked === 0);
  const bad = await readAll({ scope: "view", view: "bogus" });
  check("read-all rejects an unknown view with 400", bad.statusCode === 400);
  // The inbox's Needs reply lane lists community threads too, so its read-all marks them.
  const v6 = await mk("OPTEST-V6");
  subjectOf[v6] = "OPTEST-V6";
  await superPool.query("UPDATE tickets SET support_mode = 'community', whose_turn = 'us' WHERE id = $1", [v6]);
  asUser = TESTCO_U2;
  await readAll({ scope: "view", view: "needs_reply" });
  check("read-all in Needs reply marks a community thread that the lane shows", (await readBy(TESTCO_U2)).includes("OPTEST-V6"));
  // The Spam lane's Spam and Outreach filters each mark only their own kind.
  const v7 = await mk("OPTEST-V7");
  const v8 = await mk("OPTEST-V8");
  subjectOf[v7] = "OPTEST-V7";
  subjectOf[v8] = "OPTEST-V8";
  await superPool.query("UPDATE tickets SET spam_at = now(), spam_source = 'ai', spam_kind = 'outreach' WHERE id = $1", [v7]);
  await superPool.query("UPDATE tickets SET spam_at = now(), spam_source = 'ai', spam_kind = 'spam' WHERE id = $1", [v8]);
  // A mark from before the spam kinds existed has no kind, and counts as spam.
  await superPool.query("UPDATE tickets SET spam_kind = NULL WHERE id = $1", [v5]);
  const spamRead = async () => (await readBy(TESTCO_U2)).filter((s) => ["OPTEST-V5", "OPTEST-V7", "OPTEST-V8"].includes(s));
  await readAll({ scope: "view", view: "spam", spamKind: "outreach" });
  check("read-all in Spam with the Outreach filter marks only outreach", eq(await spamRead(), ["OPTEST-V7"]), await spamRead());
  await readAll({ scope: "view", view: "spam", spamKind: "spam" });
  check("read-all in Spam with the Spam filter marks the spam, a mark without a kind included", eq(await spamRead(), ["OPTEST-V5", "OPTEST-V7", "OPTEST-V8"]), await spamRead());
  await app.close();

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
