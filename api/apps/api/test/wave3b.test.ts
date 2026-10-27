import { appPool, relayPool, withTenant } from "@repo/db";
import { ingestInbound } from "../src/ingest.js";
import { runSimulation, listSimulations, getSimulation } from "../src/simulate.js";
import { scoreTicket, qaByAgent, qaCsatCorrelation } from "../src/qa.js";
import { listTopics } from "../src/topics.js";
import { bulkTickets } from "../src/tickets.js";
import { recordCsat } from "../src/csat.js";

// Wave-3 completion gate: agent simulation (draft+score over a sample, persisted), QA-by-agent
// leaderboard, QA↔CSAT correlation, and the topic surge flag. FORCE_RULE_MODEL keeps suggestForQuery
// on the extractive rule baseline — deterministic, no network. Postgres only; tenant A (Acme).

const A = "33333333-3333-3333-3333-333333333333";
const MARK = "WAVE3B";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

async function main() {
  // Seed a couple of answerable tickets so the sample isn't empty.
  await ingestInbound({ tenantId: A, authorType: "customer", subject: `${MARK} reset`, body: "how do I reset my password? I'm locked out." });
  const t2 = await ingestInbound({ tenantId: A, authorType: "customer", subject: `${MARK} billing`, body: "I was charged twice on my invoice, need help." });

  // ---- agent simulation ----
  const { run, items } = await runSimulation(A, { sampleSize: 5, label: `${MARK} run` });
  check("runSimulation returns a run with sample_size", run.sample_size >= 1 && run.sample_size <= 5);
  check("run has aggregate score/coverage/auto-send", run.avg_score != null && run.coverage >= 0 && run.auto_send_rate >= 0);
  check("items carry score + would_auto_send + agreement", items.length === run.sample_size && items.every((i) => typeof i.score === "number" && typeof i.would_auto_send === "boolean"));
  check("auto_send_rate ∈ [0,1]", run.auto_send_rate >= 0 && run.auto_send_rate <= 1);
  const list = await listSimulations(A);
  check("listSimulations includes the new run", list.some((r) => r.id === run.id));
  const detail = await getSimulation(A, run.id);
  check("getSimulation returns run + items", detail?.run.id === run.id && detail.items.length === run.sample_size);
  check("getSimulation on unknown id → null", (await getSimulation(A, "00000000-0000-0000-0000-000000000000")) === null);

  // ---- QA-by-agent leaderboard ----
  const agentId = await withTenant(A, async (c) => {
    const r = await c.query("SELECT id FROM users WHERE email = 'tess@testco.test'");
    return r.rowCount ? (r.rows[0].id as string) : null;
  });
  check("found the demo agent user", !!agentId);
  if (agentId) {
    await bulkTickets(A, [t2.ticketId], "assign", agentId);
    await scoreTicket(A, t2.ticketId);
    const agents = await qaByAgent(A);
    const mine = agents.find((a) => a.agentId === agentId);
    check("qaByAgent includes the assigned agent", !!mine && mine.scored >= 1);
    check("qaByAgent rolls up avg + sub-scores", !!mine && mine.avgOverall >= 0 && mine.avgResolution >= 0 && mine.avgTone >= 0);
    check("qaByAgent band mix sums to scored", !!mine && (mine.byBand.excellent + mine.byBand.good + mine.byBand.fair + mine.byBand.poor) === mine.scored);
  }

  // ---- QA ↔ CSAT correlation ----
  await scoreTicket(A, t2.ticketId);
  await recordCsat(A, t2.ticketId, 5, `${MARK} happy`);
  const corr = await qaCsatCorrelation(A);
  check("qaCsatCorrelation reports pairs ≥ 1", corr.pairs >= 1);
  check("a happy rating contributes to avgQaWhenHappy", corr.avgQaWhenHappy != null);

  // ---- topic surge flag present ----
  const topics = await listTopics(A);
  check("listTopics carries the surge flag", topics.length > 0 && topics.every((t) => typeof t.surge === "boolean" && typeof t.surgeRatio === "number"));

  await appPool.end();
  await relayPool.end();
  if (failures > 0) { console.error(`\nWAVE3B: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nWAVE3B: all checks green");
}

main().catch((e) => { console.error("wave3b seam ERROR", e); process.exit(1); });
