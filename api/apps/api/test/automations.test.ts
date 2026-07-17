import pg from "pg";
import { appPool, relayPool } from "@repo/db";
import {
  createAutomation,
  listAutomations,
  getAutomation,
  updateAutomation,
  deleteAutomation,
  listRuns,
  runAutomations,
  evaluateConditions,
  interpolate,
  parseHeaders,
  isScheduleDue,
} from "../src/automations.js";

// Automations (rules) engine seam:
//   • evaluateConditions implements the all/any AST + every operator (pure);
//   • interpolate renders {{field}} templates from context;
//   • CRUD is RLS-scoped (a rule lands in its tenant only);
//   • runAutomations end-to-end: a matching rule executes its action (assign) against a real
//     ticket, logs a success run, and bumps run_count; a non-match is silent (no run, no
//     mutation); a notify to a missing integration degrades to a 'partial' run (no throw).
// Synthetic tenant/user/ticket UUIDs (never the seeded Acme/Globex data). Needs Postgres only.

const T = "eeeeeeee-0000-4000-8000-0000000000e1";
const U = "eeeeeeee-0000-4000-8000-0000000000e2"; // assignee
const TK = "eeeeeeee-0000-4000-8000-0000000000e3"; // matching ticket
const TK2 = "eeeeeeee-0000-4000-8000-0000000000e4"; // non-matching ticket
const B = "22222222-2222-2222-2222-222222222222"; // Globex (seeded) — cross-tenant guard

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
    await superPool.query(`DELETE FROM automation_runs WHERE tenant_id IN ($1,$2)`, [T, B]);
    await superPool.query(`DELETE FROM automations WHERE tenant_id IN ($1,$2)`, [T, B]);
    await superPool.query(`DELETE FROM tickets WHERE tenant_id = $1`, [T]);
    await superPool.query(`DELETE FROM users WHERE tenant_id = $1`, [T]);
    await superPool.query(`DELETE FROM tenants WHERE id = $1`, [T]);
  };
  await clean();
  await superPool.query(`INSERT INTO tenants (id, name) VALUES ($1,'AutoTest') ON CONFLICT (id) DO NOTHING`, [T]);
  await superPool.query(
    `INSERT INTO users (tenant_id, id, email, name, role) VALUES ($1,$2,'autotest-agent@autotest.local','Auto Agent','agent')`,
    [T, U],
  );
  await superPool.query(`INSERT INTO tickets (tenant_id, id, subject, channel_type) VALUES ($1,$2,'Refund please','synthetic')`, [T, TK]);
  await superPool.query(`INSERT INTO tickets (tenant_id, id, subject, channel_type) VALUES ($1,$2,'Just saying hi','synthetic')`, [T, TK2]);

  // ---- evaluateConditions (pure) ----
  check("empty conditions match everything", evaluateConditions({ match: "all", conditions: [] }, {}) === true);
  check("undefined conditions match everything", evaluateConditions(undefined as never, {}) === true);
  check("all: every condition true → match",
    evaluateConditions({ match: "all", conditions: [
      { field: "a", op: "equals", value: "x" }, { field: "b", op: "is_not_empty", value: "" }] }, { a: "x", b: "y" }) === true);
  check("all: one condition false → no match",
    evaluateConditions({ match: "all", conditions: [
      { field: "a", op: "equals", value: "x" }, { field: "b", op: "equals", value: "z" }] }, { a: "x", b: "y" }) === false);
  check("any: one condition true → match",
    evaluateConditions({ match: "any", conditions: [
      { field: "a", op: "equals", value: "no" }, { field: "b", op: "equals", value: "y" }] }, { a: "x", b: "y" }) === true);
  check("any: all conditions false → no match",
    evaluateConditions({ match: "any", conditions: [
      { field: "a", op: "equals", value: "no" }, { field: "b", op: "equals", value: "no" }] }, { a: "x", b: "y" }) === false);
  check("contains is case-insensitive",
    evaluateConditions({ match: "all", conditions: [{ field: "body", op: "contains", value: "REFUND" }] }, { body: "I need a Refund" }) === true);
  check("not_contains",
    evaluateConditions({ match: "all", conditions: [{ field: "body", op: "not_contains", value: "spam" }] }, { body: "hello" }) === true);
  check("starts_with",
    evaluateConditions({ match: "all", conditions: [{ field: "s", op: "starts_with", value: "ur" }] }, { s: "urgent!" }) === true);
  check("gt / lt are numeric",
    evaluateConditions({ match: "all", conditions: [{ field: "n", op: "gt", value: "5" }] }, { n: "10" }) === true &&
    evaluateConditions({ match: "all", conditions: [{ field: "n", op: "lt", value: "5" }] }, { n: "10" }) === false);
  check("is_empty on a missing field → true",
    evaluateConditions({ match: "all", conditions: [{ field: "missing", op: "is_empty", value: "" }] }, {}) === true);

  // ---- interpolate ----
  check("interpolate fills known fields", interpolate("Hi {{name}} on {{channelType}}", { name: "Sam", channelType: "discord" }) === "Hi Sam on discord");
  check("interpolate blanks unknown fields", interpolate("[{{missing}}]", {}) === "[]");

  // ---- parseHeaders (http action, pure + network-free) ----
  {
    const h = parseHeaders("Authorization: Bearer {{token}}\nX-Tenant: {{tenant}}", { token: "abc", tenant: "acme" });
    check("parseHeaders interpolates values", h["Authorization"] === "Bearer abc" && h["X-Tenant"] === "acme");
  }
  check("parseHeaders skips blank / colon-less lines",
    Object.keys(parseHeaders("Content-Type: application/json\n\nnot-a-header\n", {})).length === 1);
  check("parseHeaders trims key and value",
    parseHeaders("  X-Foo :  bar  ", {})["X-Foo"] === "bar");
  check("parseHeaders on empty input → no headers",
    Object.keys(parseHeaders("", {})).length === 0);
  // http url interpolation feeds the request line (the fetch itself is exercised at runtime, not here).
  check("http url interpolates from context",
    interpolate("https://api.example.com/tickets/{{ticketId}}", { ticketId: "t-42" }) === "https://api.example.com/tickets/t-42");

  // ---- contact_update field parsing (reuses parseHeaders; pure + network-free) ----
  {
    const f = parseHeaders("Plan: Pro\nMRR: 1200\nRegion: EU", {});
    check("contact_update fields parse Key: Value lines",
      f["Plan"] === "Pro" && f["MRR"] === "1200" && f["Region"] === "EU");
  }
  {
    const f = parseHeaders("Owner: {{name}}", { name: "Sam" });
    check("contact_update fields interpolate from context", f["Owner"] === "Sam");
  }

  // ---- isScheduleDue (schedule trigger due-check; pure, no clock/DB) ----
  {
    const now = Date.UTC(2026, 6, 7, 12, 0, 0);
    check("isScheduleDue: never-run automation is always due", isScheduleDue(null, 60, now) === true);
    check("isScheduleDue: within interval → not due",
      isScheduleDue(new Date(now - 10 * 60_000).toISOString(), 60, now) === false);
    check("isScheduleDue: past interval → due",
      isScheduleDue(new Date(now - 61 * 60_000).toISOString(), 60, now) === true);
    check("isScheduleDue: exactly at interval → due",
      isScheduleDue(new Date(now - 60 * 60_000).toISOString(), 60, now) === true);
    check("isScheduleDue: unset interval defaults to 60m",
      isScheduleDue(new Date(now - 61 * 60_000).toISOString(), undefined, now) === true &&
      isScheduleDue(new Date(now - 59 * 60_000).toISOString(), undefined, now) === false);
    check("isScheduleDue: short interval (5m)",
      isScheduleDue(new Date(now - 6 * 60_000).toISOString(), 5, now) === true &&
      isScheduleDue(new Date(now - 4 * 60_000).toISOString(), 5, now) === false);
  }

  // ---- CRUD ----
  const a = await createAutomation(T, {
    name: "Escalate refunds",
    trigger: "message.received",
    conditions: { match: "all", conditions: [{ field: "body", op: "contains", value: "refund" }] },
    actions: [{ type: "assign", assigneeId: U }],
  });
  check("createAutomation returns a row with trigger mapped", a.trigger === "message.received" && a.name === "Escalate refunds");
  check("new automation is enabled by default", a.enabled === true && a.runCount === 0);
  check("listAutomations includes it", (await listAutomations(T)).some((r) => r.id === a.id));
  check("getAutomation returns it with its actions", (await getAutomation(T, a.id))?.actions?.[0]?.type === "assign");
  const upd = await updateAutomation(T, a.id, { name: "Escalate refunds v2" });
  check("updateAutomation renames", upd?.name === "Escalate refunds v2");

  // ---- engine end-to-end: matching rule assigns the ticket + logs a success run ----
  await runAutomations(T, "message.received", { ticketId: TK, body: "please issue a refund", authorType: "customer" });
  const assigned = await superPool.query("SELECT assignee_id FROM tickets WHERE id = $1", [TK]);
  check("a matching rule executed its assign action", assigned.rows[0]?.assignee_id === U);
  const runs1 = await listRuns(T, a.id);
  check("a run row was logged with status success", runs1.length === 1 && runs1[0].status === "success");
  const counted = await superPool.query("SELECT run_count FROM automations WHERE id = $1", [a.id]);
  check("run_count was incremented", counted.rows[0]?.run_count === 1);

  // ---- non-match is silent: no mutation, no run ----
  await runAutomations(T, "message.received", { ticketId: TK2, body: "just saying hello", authorType: "customer" });
  const notAssigned = await superPool.query("SELECT assignee_id FROM tickets WHERE id = $1", [TK2]);
  check("a non-matching ticket is left untouched", notAssigned.rows[0]?.assignee_id === null);
  check("a non-match logs no run", (await listRuns(T, a.id)).length === 1);

  // ---- notify to a missing integration degrades to 'partial' (no throw, no network) ----
  const n = await createAutomation(T, {
    name: "Notify ops",
    trigger: "ticket.created",
    conditions: { match: "all", conditions: [] },
    actions: [{ type: "notify", integrationId: "ffffffff-0000-4000-8000-0000000000ff", text: "new ticket {{subject}}" }],
  });
  await runAutomations(T, "ticket.created", { ticketId: TK, subject: "Refund please" });
  const nruns = await listRuns(T, n.id);
  check("a failed notify action degrades the run to 'partial'", nruns.length === 1 && nruns[0].status === "partial");

  // ---- rule chaining: assign chains ticket.assigned → a downstream rule closes the ticket ----
  const TK3 = "eeeeeeee-0000-4000-8000-0000000000e5";
  await superPool.query(`INSERT INTO tickets (tenant_id, id, subject, channel_type) VALUES ($1,$2,'Chain me','synthetic')`, [T, TK3]);
  await createAutomation(T, {
    name: "Chain: assign on create",
    trigger: "ticket.created",
    conditions: { match: "all", conditions: [] },
    actions: [{ type: "assign", assigneeId: U }],
  });
  await createAutomation(T, {
    name: "Chain: close on assign",
    trigger: "ticket.assigned",
    conditions: { match: "all", conditions: [] },
    actions: [{ type: "set_status", status: "closed" }],
  });
  await runAutomations(T, "ticket.created", { ticketId: TK3 });
  // Chaining is fire-and-forget; poll briefly for the downstream close to land.
  let chained = false;
  for (let i = 0; i < 25 && !chained; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const st = await superPool.query("SELECT status, assignee_id FROM tickets WHERE id = $1", [TK3]);
    chained = st.rows[0]?.status === "closed" && st.rows[0]?.assignee_id === U;
  }
  check("assign chains ticket.assigned → a downstream rule closed the ticket", chained);

  // ---- RLS isolation ----
  check("automations do not leak across tenants", !(await listAutomations(B)).some((r) => r.id === a.id));

  // ---- delete ----
  check("deleteAutomation removes it", (await deleteAutomation(T, a.id)) === true);
  check("getAutomation is null after delete", (await getAutomation(T, a.id)) === null);

  await clean();
  await superPool.end();
  await appPool.end();
  await relayPool.end();

  if (failures > 0) { console.error(`\nAUTOMATIONS: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nAUTOMATIONS: all checks green");
}

main().catch((e) => { console.error("automations seam ERROR", e); process.exit(1); });
