import pg from "pg";
import { appPool, relayPool } from "@repo/db";
import {
  createAutomation,
  runAutomations,
  evaluateConditions,
  flowEffect,
  agentToolsEffect,
  EFFECT_MIN_ROLE,
} from "../src/automations.js";
import { projectRoutingRules, projectSurveys } from "../src/seedflows.js";
import { authorAutomation, sanitizeAuthoredActions } from "../src/authoring.js";
import { detectSlaBreaches } from "../src/sla.js";

// Dogfood L1/L2 seam — the net-new engine capabilities + the routing/survey projection:
//   • evalOne array/list ops (contains_any, in) over scalar + array (tags) fields;
//   • strategy-aware assign (round_robin cursor), set_priority, add_tags actions;
//   • survey action once-per-dedupe-key;
//   • projectRoutingRules → managed seed automations that first-match-assign via `stop`;
//   • projectSurveys → a ticket.closed survey automation.
// Synthetic tenant/users/tickets (never the seeded demo data). Postgres only; FORCE_RULE_MODEL
// keeps it model-free.

const T = "dddddddd-0000-4000-8000-0000000000d1";
const U1 = "dddddddd-0000-4000-8000-0000000000d2";
const U2 = "dddddddd-0000-4000-8000-0000000000d3";

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
    for (const tbl of ["automation_runs", "automations", "flow_dedupe", "assignment_cursors", "routing_rules", "survey_settings", "sla_policies", "messages", "tickets", "users"]) {
      await superPool.query(`DELETE FROM ${tbl} WHERE tenant_id = $1`, [T]).catch(() => {});
    }
    await superPool.query(`DELETE FROM tenants WHERE id = $1`, [T]);
  };
  await clean();
  await superPool.query(`INSERT INTO tenants (id, name) VALUES ($1,'DogfoodTest') ON CONFLICT DO NOTHING`, [T]);
  await superPool.query(`INSERT INTO users (tenant_id, id, email, name, role) VALUES ($1,$2,'d1@dogfood.local','Agent One','agent'),($1,$3,'d2@dogfood.local','Agent Two','agent')`, [T, U1, U2]);

  const mkTicket = async (id: string, subject = "Help", channel = "synthetic") =>
    superPool.query(`INSERT INTO tickets (tenant_id, id, subject, channel_type) VALUES ($1,$2,$3,$4)`, [T, id, subject, channel]);
  const priorityOf = async (id: string) => (await superPool.query(`SELECT priority FROM tickets WHERE id=$1`, [id])).rows[0]?.priority;
  const tagsOf = async (id: string) => (await superPool.query(`SELECT tags FROM tickets WHERE id=$1`, [id])).rows[0]?.tags as string[];
  const assigneeOf = async (id: string) => (await superPool.query(`SELECT assignee_id FROM tickets WHERE id=$1`, [id])).rows[0]?.assignee_id;

  // ---- evalOne array/list operators (pure) ----
  check("contains_any (scalar): priority in list matches",
    evaluateConditions({ match: "all", conditions: [{ field: "priority", op: "contains_any", value: "high,urgent" }] }, { priority: "high" }) === true);
  check("in (scalar): priority not in list → no match",
    evaluateConditions({ match: "all", conditions: [{ field: "priority", op: "in", value: "high,urgent" }] }, { priority: "normal" }) === false);
  check("in (scalar): priority in list → match",
    evaluateConditions({ match: "all", conditions: [{ field: "priority", op: "in", value: "high,urgent" }] }, { priority: "urgent" }) === true);
  check("array tags contains_any overlaps",
    evaluateConditions({ match: "all", conditions: [{ field: "tags", op: "contains_any", value: "vip,us" }] }, { tags: ["eu", "vip"] }) === true);
  check("array tags contains (membership)",
    evaluateConditions({ match: "all", conditions: [{ field: "tags", op: "contains", value: "vip" }] }, { tags: ["eu", "vip"] }) === true);
  check("array tags is_empty on []",
    evaluateConditions({ match: "all", conditions: [{ field: "tags", op: "is_empty", value: "" }] }, { tags: [] }) === true);
  check("array tags contains_any no overlap → no match",
    evaluateConditions({ match: "all", conditions: [{ field: "tags", op: "contains_any", value: "us,apac" }] }, { tags: ["eu"] }) === false);

  // ---- set_priority + add_tags actions (linear automation) ----
  const TK1 = "dddddddd-0000-4000-8000-0000000000e1";
  await mkTicket(TK1);
  await createAutomation(T, {
    name: "Tag + prioritise VIP",
    trigger: "ticket.created",
    conditions: { match: "all", conditions: [] },
    actions: [{ type: "set_priority", priority: "high" }, { type: "add_tags", tags: ["vip", "vip"] }],
  });
  await runAutomations(T, "ticket.created", { ticketId: TK1 });
  check("set_priority action set the ticket priority", (await priorityOf(TK1)) === "high");
  check("add_tags action appended (deduped) tags", JSON.stringify((await tagsOf(TK1)).sort()) === JSON.stringify(["vip"]));

  // ---- survey action once-per-dedupe-key ----
  const TK2 = "dddddddd-0000-4000-8000-0000000000e2";
  await mkTicket(TK2);
  await createAutomation(T, {
    name: "CSAT on close",
    trigger: "ticket.closed",
    conditions: { match: "all", conditions: [] },
    actions: [{ type: "survey", surveyKind: "csat" }],
  });
  await runAutomations(T, "ticket.closed", { ticketId: TK2 });
  await runAutomations(T, "ticket.closed", { ticketId: TK2 }); // second close must NOT re-survey
  const surveyMsgs = await superPool.query(
    `SELECT count(*)::int AS n FROM messages WHERE tenant_id=$1 AND ticket_id=$2 AND author_type='agent'`, [T, TK2]);
  check("survey delivered exactly once (dedupe)", surveyMsgs.rows[0].n === 1);
  const dedupe = await superPool.query(`SELECT count(*)::int AS n FROM flow_dedupe WHERE tenant_id=$1`, [T]);
  check("flow_dedupe reserved the survey key", dedupe.rows[0].n === 1);

  // ---- routing projection: first-match assign + stop skips later rules ----
  // Rule 1 (position 0): channel=synthetic → assign U1. Rule 2 (position 1): catch-all → assign U2.
  await superPool.query(
    `INSERT INTO routing_rules (tenant_id, name, position, enabled, conditions, strategy, assignee_ids)
     VALUES ($1,'synthetic→U1',0,true,$2::jsonb,'specific',$3::uuid[])`,
    [T, JSON.stringify([{ field: "channel", op: "eq", value: "synthetic" }]), [U1]]);
  await superPool.query(
    `INSERT INTO routing_rules (tenant_id, name, position, enabled, conditions, strategy, assignee_ids)
     VALUES ($1,'catch-all→U2',1,true,'[]'::jsonb,'specific',$2::uuid[])`,
    [T, [U2]]);
  await projectRoutingRules(T);
  const managed = await superPool.query(`SELECT count(*)::int AS n FROM automations WHERE tenant_id=$1 AND managed_by='routing'`, [T]);
  check("projectRoutingRules created 2 managed automations", managed.rows[0].n === 2);
  const TK3 = "dddddddd-0000-4000-8000-0000000000e3";
  await mkTicket(TK3, "Routed", "synthetic");
  await runAutomations(T, "ticket.created", { ticketId: TK3 });
  check("routing first-match assigned U1 (rule 1), stop skipped rule 2", (await assigneeOf(TK3)) === U1);

  // ---- round_robin strategy cycles the pool via the persisted cursor ----
  await superPool.query(`DELETE FROM automations WHERE tenant_id=$1`, [T]);
  await createAutomation(T, {
    name: "RR over pool",
    trigger: "ticket.created",
    conditions: { match: "all", conditions: [] },
    actions: [{ type: "assign", strategy: "round_robin", assigneeIds: [U1, U2], cursorKey: "test-rr" }, { type: "stop" }],
  });
  const RR1 = "dddddddd-0000-4000-8000-0000000000f1";
  const RR2 = "dddddddd-0000-4000-8000-0000000000f2";
  await mkTicket(RR1); await mkTicket(RR2);
  await runAutomations(T, "ticket.created", { ticketId: RR1 });
  await runAutomations(T, "ticket.created", { ticketId: RR2 });
  const a1 = await assigneeOf(RR1), a2 = await assigneeOf(RR2);
  check("round_robin assigned both pool members (cursor advanced)", a1 !== a2 && [U1, U2].includes(a1) && [U1, U2].includes(a2));

  // ---- survey projection ----
  await superPool.query(`INSERT INTO survey_settings (tenant_id, csat_enabled, nps_enabled) VALUES ($1,true,true) ON CONFLICT (tenant_id) DO UPDATE SET csat_enabled=true, nps_enabled=true`, [T]);
  await projectSurveys(T);
  const surveyAuto = await superPool.query(`SELECT trigger_event, actions FROM automations WHERE tenant_id=$1 AND managed_by='surveys'`, [T]);
  check("projectSurveys created a ticket.closed survey automation",
    surveyAuto.rowCount === 1 && surveyAuto.rows[0].trigger_event === "ticket.closed" && surveyAuto.rows[0].actions[0].surveyKind === "both");
  // Both toggles off → projection removes the managed survey automation.
  await superPool.query(`UPDATE survey_settings SET csat_enabled=false, nps_enabled=false WHERE tenant_id=$1`, [T]);
  await projectSurveys(T);
  const surveyGone = await superPool.query(`SELECT count(*)::int AS n FROM automations WHERE tenant_id=$1 AND managed_by='surveys'`, [T]);
  check("projectSurveys removes the survey automation when both toggles off", surveyGone.rows[0].n === 0);

  // ---- AI flow authoring (E2) — sanitizer (pure) + no-model path (deterministic) ----
  {
    const clean = sanitizeAuthoredActions([
      { type: "assign", strategy: "round_robin", assigneeId: "Sam" },  // pool strategy → id nulled
      { type: "notify", integrationId: "slack", text: "hi" },          // non-uuid id dropped
      { type: "set_priority", priority: "high" },
      "garbage", null,                                                  // non-objects skipped
    ]);
    check("sanitize nulls a pool-assign's bogus assigneeId", clean[0].assigneeId === null);
    check("sanitize drops a non-uuid integrationId", clean[1].integrationId === undefined && clean[1].text === "hi");
    check("sanitize keeps valid actions + skips non-objects", clean.length === 3 && clean[2].type === "set_priority");
  }
  {
    const uuid = "dddddddd-0000-4000-8000-0000000000d2";
    const kept = sanitizeAuthoredActions([{ type: "assign", strategy: "specific", assigneeId: uuid }]);
    check("sanitize keeps a valid uuid assigneeId", kept[0].assigneeId === uuid);
  }
  {
    // FORCE_RULE_MODEL → no hosted model → authoring returns an honest error, never throws.
    const res = await authorAutomation(T, "when a discord ticket arrives, tag it and assign round robin");
    check("authorAutomation without a hosted model returns a clear error", !res.automation && /hosted model/i.test(res.error ?? ""));
  }

  // ---- SLA-breach detector (D3): overdue ticket → sla.breached → a flow reacts, once ----
  {
    await superPool.query(
      `INSERT INTO sla_policies (tenant_id, first_response_mins, resolution_mins, enabled) VALUES ($1,60,1440,true)
       ON CONFLICT (tenant_id) DO UPDATE SET first_response_mins=60, resolution_mins=1440, enabled=true`, [T]);
    const SLATK = "dddddddd-0000-4000-8000-0000000000c1";
    await superPool.query(
      `INSERT INTO tickets (tenant_id, id, subject, channel_type, created_at) VALUES ($1,$2,'SLA breach','synthetic', now() - interval '2 hours')`, [T, SLATK]);
    await createAutomation(T, {
      name: "Escalate SLA breaches", trigger: "sla.breached",
      conditions: { match: "all", conditions: [] }, actions: [{ type: "add_tags", tags: ["sla-breach"] }],
    });
    await detectSlaBreaches();
    let tagged = false;
    for (let i = 0; i < 30 && !tagged; i++) {
      await new Promise((r) => setTimeout(r, 100));
      tagged = ((await superPool.query(`SELECT tags FROM tickets WHERE id=$1`, [SLATK])).rows[0]?.tags ?? []).includes("sla-breach");
    }
    check("SLA detector emitted sla.breached → the flow tagged the overdue ticket", tagged);
    const key = await superPool.query(`SELECT count(*)::int AS n FROM flow_dedupe WHERE tenant_id=$1 AND dedupe_key=$2`, [T, `sla.breached:first_response:${SLATK}`]);
    check("SLA detector reserved the breach dedupe key", key.rows[0].n === 1);
    await detectSlaBreaches(); // second scan must not re-reserve / re-fire
    const key2 = await superPool.query(`SELECT count(*)::int AS n FROM flow_dedupe WHERE tenant_id=$1 AND dedupe_key=$2`, [T, `sla.breached:first_response:${SLATK}`]);
    check("SLA breach fires once per ticket/target (deduped across scans)", key2.rows[0].n === 1);
  }

  // ── E3: RBAC-by-effect (pure-function policy) ──────────────────────────────
  {
    check("flowEffect: read-only flow (web_fetch→set_fields) is read",
      flowEffect({ actions: [{ type: "web_fetch", url: "x" }, { type: "set_fields", setFields: "a: b" }] } as any) === "read");
    check("flowEffect: a reply action makes the flow update",
      flowEffect({ actions: [{ type: "web_fetch", url: "x" }, { type: "reply", body: "hi" }] } as any) === "update");
    check("flowEffect: an http action makes the flow mixed",
      flowEffect({ actions: [{ type: "reply", body: "hi" }, { type: "http", method: "POST", url: "x" }] } as any) === "mixed");
    check("flowEffect: reads a graph agent node's tools (update tool → update)",
      flowEffect({ graph: { nodes: [{ id: "a", type: "agent", config: { agent: { tools: ["web_fetch", "add_tags"] } } }], edges: [] } } as any) === "update");
    check("agentToolsEffect: default tools (reply/set_status) are update", agentToolsEffect(undefined) === "update");
    check("agentToolsEffect: read-only tools stay read", agentToolsEffect(["web_fetch", "set_fields"]) === "read");
    check("EFFECT_MIN_ROLE: read→viewer, update→agent, mixed→admin",
      EFFECT_MIN_ROLE.read === "viewer" && EFFECT_MIN_ROLE.update === "agent" && EFFECT_MIN_ROLE.mixed === "admin");
  }

  await clean();
  await superPool.end();
  await appPool.end();
  await relayPool.end();

  if (failures > 0) { console.error(`\nDOGFOOD: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nDOGFOOD: all checks green");
}

main().catch((e) => { console.error("dogfood seam ERROR", e); process.exit(1); });
