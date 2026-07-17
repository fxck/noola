import { withTenant } from "@repo/db";
import { getOpsDashboard, getCsatReport } from "../src/analytics.js";
import { runReport, REPORT_METRICS } from "../src/reports.js";
import { getSlaPolicy, upsertSlaPolicy } from "../src/sla.js";
import { createTeam, deleteTeam } from "../src/teams.js";
import { setTicketTeam } from "../src/tickets.js";

// Wave 4 reporting: ops dashboard (queue/today/oldest-waiting/breaching), CSAT report
// (byWeek + leaderboard), and the report builder engine (bucketing, percentiles, SLA rates,
// filters, compare). Needs Postgres; re-runnable; demo tenant.

const A = "33333333-3333-3333-3333-333333333333";
const ALES = "c0000000-0000-0000-0000-000000000001";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

async function makeTicket(subject: string, opts: {
  daysAgo?: number; closeAfterHours?: number; frAfterHours?: number;
  assignee?: string; whoseTurn?: string; csat?: number; priority?: string;
} = {}): Promise<string> {
  return withTenant(A, async (c) => {
    const created = `now() - interval '${opts.daysAgo ?? 0} days'`;
    const r = await c.query(
      `INSERT INTO tickets (tenant_id, subject, status, channel_type, whose_turn, assignee_id, priority, created_at)
       VALUES (current_tenant(), $1, 'open', 'widget', $2, $3, $4, ${created}) RETURNING id`,
      [subject, opts.whoseTurn ?? "us", opts.assignee ?? null, opts.priority ?? "normal"],
    );
    const id = r.rows[0].id as string;
    // updated_at defaults to now() — pin it to created_at so age-anchored views (oldest
    // waiting falls back to updated_at) see the seeded age, not the insert moment.
    await c.query("UPDATE tickets SET updated_at = created_at WHERE id = $1", [id]);
    if (opts.frAfterHours !== undefined) {
      await c.query(
        `INSERT INTO messages (tenant_id, ticket_id, author_type, body, created_at)
         VALUES (current_tenant(), $1, 'agent', 'w4 reply', (SELECT created_at FROM tickets WHERE id = $1) + interval '${opts.frAfterHours} hours')`,
        [id],
      );
    }
    if (opts.closeAfterHours !== undefined) {
      await c.query(
        `UPDATE tickets SET status='closed', closed_at = created_at + interval '${opts.closeAfterHours} hours' WHERE id = $1`,
        [id],
      );
    }
    if (opts.csat !== undefined) {
      await c.query(
        `INSERT INTO csat_responses (tenant_id, ticket_id, rating, created_at)
         VALUES (current_tenant(), $1, $2, (SELECT created_at FROM tickets WHERE id = $1) + interval '1 hour')`,
        [id, opts.csat],
      );
    }
    return id;
  });
}

async function cleanup() {
  await withTenant(A, async (c) => {
    await c.query("DELETE FROM tickets WHERE subject LIKE 'w4:%'");
    await c.query("DELETE FROM teams WHERE name LIKE 'W4 %'");
  });
}

async function main() {
  await cleanup();
  const policyBefore = await getSlaPolicy(A);
  await upsertSlaPolicy(A, { firstResponseMins: 60, resolutionMins: 1440, enabled: true, businessHoursEnabled: false });

  // Seed: a waiting-old ticket (breached FR), a fresh answered+closed one (met), a CSAT pair.
  const team = await createTeam(A, { name: "W4 Pod", memberIds: [ALES] });
  const oldWaiting = await makeTicket("w4: old waiting", { daysAgo: 45, whoseTurn: "us", priority: "high" });
  await setTicketTeam(A, oldWaiting, team.id);
  // setTicketTeam bumps updated_at — re-pin so the waiting-age anchor keeps the seeded age.
  await withTenant(A, (c) => c.query("UPDATE tickets SET updated_at = created_at WHERE id = $1", [oldWaiting]));
  await makeTicket("w4: quick met", { daysAgo: 1, frAfterHours: 0.5, closeAfterHours: 2, assignee: ALES, csat: 5 });
  await makeTicket("w4: slow", { daysAgo: 5, frAfterHours: 4, closeAfterHours: 48, assignee: ALES, csat: 3 });

  // ── ops dashboard ───────────────────────────────────────────────────────────
  const ops = await getOpsDashboard(A);
  check("ops queue counts sane", ops.queue.open >= 1 && ops.queue.waiting >= 1);
  check("ops today counters present", ops.today.created >= 0 && ops.today.closed >= 0);
  const oldest = ops.oldestWaiting.find((t) => t.subject === "w4: old waiting");
  check("oldest-waiting surfaces the old ticket w/ team", oldest !== undefined && oldest.teamName === "W4 Pod");
  check("oldest-waiting sorted oldest-first", ops.oldestWaiting.length < 2
    || new Date(ops.oldestWaiting[0].at).getTime() <= new Date(ops.oldestWaiting[1].at).getTime());
  const breach = ops.breaching.find((t) => t.subject === "w4: old waiting");
  check("breaching lists the unanswered old ticket (FR breached)", breach?.target === "first_response" && breach?.state === "breached");
  check("ops slaEnabled reflects policy", ops.slaEnabled === true);

  // ── csat report ─────────────────────────────────────────────────────────────
  const csat = await getCsatReport(A, 12);
  check("csat byWeek has our responses", csat.byWeek.reduce((a, w) => a + w.responses, 0) >= 2);
  const lb = csat.leaderboard.find((a) => a.agentId === ALES);
  check("leaderboard: Aleš closed + responses + avg", (lb?.closed ?? 0) >= 2 && (lb?.responses ?? 0) >= 2 && lb?.avgCsat === 4);
  check("leaderboard avgFirstResponseHours computed", lb?.avgFirstResponseHours !== null && (lb?.avgFirstResponseHours ?? 0) > 0);
  check("leaderboard includes idle agents", csat.leaderboard.length >= 2);

  // ── report engine ───────────────────────────────────────────────────────────
  const allKeys = REPORT_METRICS.map((m) => m.key);
  check("catalog has 14 metrics", allKeys.length === 14);
  const rep = await runReport(A, {
    metrics: ["volume", "closed", "ttfr_avg", "ttfr_p90", "ttr_median", "sla_fr_rate", "csat_avg", "deflection_rate"],
    groupBy: "day",
    from: new Date(Date.now() - 7 * 86_400_000).toISOString(),
    compare: true,
  });
  check("report buckets are daily over 7d", rep.groupBy === "day" && rep.buckets.length >= 7 && rep.buckets.length <= 8);
  const vol = rep.series.find((s) => s.metric === "volume");
  check("volume total counts the seeded window", (vol?.total ?? 0) >= 3);
  const ttfr = rep.series.find((s) => s.metric === "ttfr_avg");
  check("ttfr_avg computed with unit hours", ttfr?.unit === "hours" && ttfr?.total !== null && (ttfr?.total ?? 0) > 0);
  const sla = rep.series.find((s) => s.metric === "sla_fr_rate");
  check("sla_fr_rate is a percent with decided data", sla?.unit === "percent" && sla?.total !== null);
  const csatS = rep.series.find((s) => s.metric === "csat_avg");
  // Shared dev DB may hold other in-window responses — assert plausibility, not equality.
  check("csat_avg total plausible (1–5)", csatS?.total !== null && (csatS?.total ?? 0) >= 1 && (csatS?.total ?? 0) <= 5);
  check("compare block present with totals", rep.compare !== undefined && rep.compare.totals.length === 8);

  // team filter narrows
  const teamRep = await runReport(A, { metrics: ["volume"], teamId: team.id, from: new Date(Date.now() - 60 * 86_400_000).toISOString() });
  check("teamId filter narrows volume to the lane", teamRep.series[0].total === 1);
  const agentRep = await runReport(A, { metrics: ["closed"], agentId: ALES, from: new Date(Date.now() - 7 * 86_400_000).toISOString() });
  check("agentId filter narrows closed", (agentRep.series[0].total ?? 0) >= 2);

  let badRange = false;
  try { await runReport(A, { metrics: ["volume"], from: "2026-01-02", to: "2026-01-01" }); } catch { badRange = true; }
  check("inverted range rejected", badRange);

  // restore
  await upsertSlaPolicy(A, {
    firstResponseMins: policyBefore.firstResponseMins,
    resolutionMins: policyBefore.resolutionMins,
    enabled: policyBefore.enabled,
    businessHoursEnabled: policyBefore.businessHoursEnabled,
    tzOffsetMins: policyBefore.businessHours.tzOffsetMins,
    workdays: policyBefore.businessHours.workdays,
    dayStartMin: policyBefore.businessHours.dayStartMin,
    dayEndMin: policyBefore.businessHours.dayEndMin,
  });
  await deleteTeam(A, team.id);
  await cleanup();
  console.log(failures === 0 ? "\nreports: ALL PASS" : `\nreports: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
