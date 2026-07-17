import pg from "pg";
import { appPool, relayPool } from "@repo/db";
import { createRun, listRuns } from "../src/runs.js";
import { createAutomation, deleteAutomation, runAutomations } from "../src/automations.js";

// Runner producer seam:
//   • createRun writes a queued runner_runs row AND a `jobs.run` outbox event in ONE txn
//     (transactional enqueue — the drainer publishes it, the runner consumes it);
//   • the enqueued job carries the {runId, cmd} contract the worker expects;
//   • listRuns is RLS-scoped;
//   • the `run` automation action routes through createRun (enqueues on match).
// Synthetic tenant (never the seeded Acme/Globex data). Needs Postgres only.

const T = "dddddddd-0000-4000-8000-0000000000e1";
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
    await superPool.query(`DELETE FROM runner_runs WHERE tenant_id IN ($1,$2)`, [T, B]);
    await superPool.query(`DELETE FROM outbox WHERE tenant_id = $1 AND subject = 'jobs.run'`, [T]);
    await superPool.query(`DELETE FROM automation_runs WHERE tenant_id = $1`, [T]);
    await superPool.query(`DELETE FROM automations WHERE tenant_id = $1`, [T]);
    await superPool.query(`DELETE FROM tenants WHERE id = $1`, [T]);
  };
  await clean();
  await superPool.query(`INSERT INTO tenants (id, name) VALUES ($1,'RunsTest') ON CONFLICT (id) DO NOTHING`, [T]);

  // ---- createRun: a queued row + a transactional jobs.run enqueue ----
  const run = await createRun(T, "manual", { cmd: "echo hello" });
  check("createRun returns an id + queued status", typeof run.id === "string" && run.status === "queued");

  const row = await superPool.query("SELECT status, kind, payload FROM runner_runs WHERE tenant_id=$1 AND id=$2", [T, run.id]);
  check("a queued runner_runs row is written", row.rowCount === 1 && row.rows[0].status === "queued" && row.rows[0].kind === "manual");
  check("the run payload carries the cmd", (row.rows[0]?.payload as { cmd?: string })?.cmd === "echo hello");

  const ob = await superPool.query(
    "SELECT payload FROM outbox WHERE tenant_id=$1 AND subject='jobs.run' AND payload->>'runId'=$2", [T, run.id]);
  check("an outbox jobs.run event is enqueued in the same txn", ob.rowCount === 1);
  check("the enqueued job carries the {runId, cmd} worker contract",
    (ob.rows[0]?.payload as { runId?: string })?.runId === run.id &&
    (ob.rows[0]?.payload as { cmd?: string })?.cmd === "echo hello");

  // ---- listRuns + RLS isolation ----
  const mine = await listRuns(T);
  check("listRuns returns the run", mine.some((r) => r.id === run.id));
  const theirs = await listRuns(B);
  check("runs do not leak across tenants (RLS)", !theirs.some((r) => r.id === run.id));

  // ---- the `run` automation action enqueues through createRun ----
  const auto = await createAutomation(T, {
    name: "Kick a build on new ticket",
    trigger: "ticket.created",
    conditions: { match: "all", conditions: [] },
    actions: [{ type: "run", cmd: "build project" }],
  });
  await runAutomations(T, "ticket.created", {}); // a run action needs no ticket
  const fromRule = await superPool.query(
    "SELECT count(*)::int AS n FROM runner_runs WHERE tenant_id=$1 AND kind='automation'", [T]);
  check("a `run` automation action creates an automation-kind run", (fromRule.rows[0]?.n as number) >= 1);
  await deleteAutomation(T, auto.id);

  await clean();
  await superPool.end();
  await appPool.end();
  await relayPool.end();

  if (failures > 0) { console.error(`\nRUNS: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nRUNS: all checks green");
}

main().catch((e) => { console.error("runs seam ERROR", e); process.exit(1); });
