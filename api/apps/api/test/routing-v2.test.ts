import { withTenant } from "@repo/db";
import { resolveAssignee, updateUserRouting, reassignOpenTickets } from "../src/assignments.js";
import { createTeam, deleteTeam } from "../src/teams.js";
import { setTicketTeam } from "../src/tickets.js";
import { createRoutingRule, deleteRoutingRule } from "../src/routing.js";
import { getSlaReport, getWorkload } from "../src/analytics.js";
import { getSlaPolicy, upsertSlaPolicy } from "../src/sla.js";

// Routing v2 (item 12): skills gate, OOO exclusion + one-shot hand-back, load caps — all at
// pool-pick time. SLA adherence (item 13): decided-only rates, week/priority/team buckets via
// the SAME computeSla math as the badges. Needs Postgres; re-runnable; demo tenant.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const ALES = "c0000000-0000-0000-0000-000000000001";
const SAM = "c0000000-0000-0000-0000-000000000002";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

async function makeTicket(subject: string, opts: { assignee?: string; createdDaysAgo?: number; closeAfterHours?: number; frAfterHours?: number; priority?: string } = {}): Promise<string> {
  return withTenant(A, async (c) => {
    const created = `now() - interval '${opts.createdDaysAgo ?? 0} days'`;
    const r = await c.query(
      `INSERT INTO tickets (tenant_id, subject, status, channel_type, whose_turn, assignee_id, priority, created_at)
       VALUES (current_tenant(), $1, 'open', 'widget', 'us', $2, $3, ${created}) RETURNING id`,
      [subject, opts.assignee ?? null, opts.priority ?? "normal"],
    );
    const id = r.rows[0].id as string;
    if (opts.frAfterHours !== undefined) {
      await c.query(
        `INSERT INTO messages (tenant_id, ticket_id, author_type, body, created_at)
         VALUES (current_tenant(), $1, 'agent', 'rv2 reply', (SELECT created_at FROM tickets WHERE id = $1) + interval '${opts.frAfterHours} hours')`,
        [id],
      );
    }
    if (opts.closeAfterHours !== undefined) {
      await c.query(
        `UPDATE tickets SET status = 'closed',
                closed_at = created_at + interval '${opts.closeAfterHours} hours' WHERE id = $1`,
        [id],
      );
    }
    return id;
  });
}

async function cleanup() {
  await withTenant(A, async (c) => {
    await c.query("DELETE FROM tickets WHERE subject LIKE 'rv2:%'");
    await c.query("DELETE FROM teams WHERE name LIKE 'RV2 %'");
    await c.query("DELETE FROM assignment_cursors WHERE key LIKE 'rv2-%'");
    await c.query("UPDATE users SET skills = '{}', out_of_office = false, max_open_tickets = NULL WHERE id = ANY($1::uuid[])", [[ALES, SAM]]);
  });
}

async function main() {
  await cleanup();
  const policyBefore = await getSlaPolicy(A);

  // ── updateUserRouting round-trip ────────────────────────────────────────────
  const ur = await updateUserRouting(A, ALES, { skills: ["billing", "cs"], maxOpenTickets: 5 });
  check("updateUserRouting sets skills + cap", ur?.skills.join() === "billing,cs" && ur?.max_open_tickets === 5);
  check("listUsers-visible flags default sane", ur?.out_of_office === false);

  // ── skills gate ─────────────────────────────────────────────────────────────
  const pickBilling = await withTenant(A, (c) =>
    resolveAssignee(c, { strategy: "round_robin", assigneeIds: [ALES, SAM], cursorKey: "rv2-skill", requiredSkills: ["billing"] }),
  );
  check("skill gate narrows pool to the skilled agent", pickBilling === ALES);
  const pickNone = await withTenant(A, (c) =>
    resolveAssignee(c, { strategy: "round_robin", assigneeIds: [ALES, SAM], cursorKey: "rv2-skill2", requiredSkills: ["kernel-dev"] }),
  );
  check("no agent carries the skill → null (stays unassigned)", pickNone === null);

  // ── OOO exclusion ───────────────────────────────────────────────────────────
  await updateUserRouting(A, ALES, { outOfOffice: true });
  const pickOoo = await withTenant(A, (c) =>
    resolveAssignee(c, { strategy: "round_robin", assigneeIds: [ALES, SAM], cursorKey: "rv2-ooo" }),
  );
  check("OOO agent never picked from a pool", pickOoo === SAM);
  const pickSpecific = await withTenant(A, (c) =>
    resolveAssignee(c, { strategy: "specific", specificId: ALES, cursorKey: "rv2-spec" }),
  );
  check("specific assignment bypasses eligibility (human choice)", pickSpecific === ALES);
  await updateUserRouting(A, ALES, { outOfOffice: false });

  // ── load cap ────────────────────────────────────────────────────────────────
  await updateUserRouting(A, SAM, { maxOpenTickets: 1 });
  await makeTicket("rv2: sam load", { assignee: SAM });
  const pickCapped = await withTenant(A, (c) =>
    resolveAssignee(c, { strategy: "least_loaded", assigneeIds: [SAM], cursorKey: "rv2-cap" }),
  );
  check("agent at cap is ineligible", pickCapped === null);
  await updateUserRouting(A, SAM, { maxOpenTickets: null });
  const pickUncapped = await withTenant(A, (c) =>
    resolveAssignee(c, { strategy: "least_loaded", assigneeIds: [SAM], cursorKey: "rv2-cap2" }),
  );
  check("clearing the cap restores eligibility", pickUncapped === SAM);

  // ── OOO hand-back ───────────────────────────────────────────────────────────
  const team = await createTeam(A, { name: "RV2 Pod", memberIds: [ALES, SAM] });
  const tTeam = await makeTicket("rv2: teamed", { assignee: ALES });
  await setTicketTeam(A, tTeam, team.id);
  const tSolo = await makeTicket("rv2: solo", { assignee: ALES });
  await updateUserRouting(A, ALES, { outOfOffice: true });
  const handback = await reassignOpenTickets(A, ALES);
  // ≥, not ===: the shared dev DB may hold other open tickets on Aleš's queue (demo data) —
  // the hand-back correctly sweeps those too; the exact end-state is asserted per-ticket below.
  check("hand-back: team ticket → teammate, solo → unassigned", handback.reassigned >= 1 && handback.unassigned >= 1);
  const after = await withTenant(A, (c) =>
    c.query("SELECT id, assignee_id FROM tickets WHERE id = ANY($1::uuid[])", [[tTeam, tSolo]]),
  );
  const rowsById = new Map(after.rows.map((r) => [r.id, r.assignee_id]));
  check("teamed ticket went to Sam", rowsById.get(tTeam) === SAM);
  check("solo ticket unassigned", rowsById.get(tSolo) === null);
  await updateUserRouting(A, ALES, { outOfOffice: false, skills: [] });

  // ── routing rule projection carries requiredSkills ──────────────────────────
  const rule = await createRoutingRule(A, {
    name: "RV2 skills rule",
    conditions: [{ field: "subject", op: "contains", value: "rv2-routed" }],
    strategy: "round_robin",
    requiredSkills: ["billing"],
  });
  check("rule stores required_skills", rule.required_skills.join() === "billing");
  const projected = await withTenant(A, async (c) => {
    const r = await c.query("SELECT actions FROM automations WHERE managed_by = 'routing' AND name = 'RV2 skills rule'");
    return (r.rows[0]?.actions as Array<Record<string, unknown>> | undefined)?.find((a) => a.type === "assign");
  });
  check("projection carries requiredSkills", Array.isArray(projected?.requiredSkills) && (projected?.requiredSkills as string[])[0] === "billing");
  await deleteRoutingRule(A, rule.id);

  // ── workload exposes OOO ────────────────────────────────────────────────────
  await updateUserRouting(A, SAM, { outOfOffice: true });
  const wl = await getWorkload(A);
  check("workload byAgent carries outOfOffice", wl.byAgent.find((a) => a.agentId === SAM)?.outOfOffice === true);
  await updateUserRouting(A, SAM, { outOfOffice: false });

  // ── SLA adherence report ────────────────────────────────────────────────────
  await upsertSlaPolicy(A, { firstResponseMins: 60, resolutionMins: 1440, enabled: true, businessHoursEnabled: false });
  // decided: fr met (30m) + res met (2h)
  await makeTicket("rv2: sla met", { createdDaysAgo: 3, frAfterHours: 0.5, closeAfterHours: 2, priority: "high" });
  // decided: fr breached (3h) + res breached (open, created 3d ago > 24h target)
  const tBreach = await makeTicket("rv2: sla breach", { createdDaysAgo: 3, frAfterHours: 3, priority: "high" });
  await setTicketTeam(A, tBreach, team.id);
  const report = await getSlaReport(A, 8);
  check("report enabled + window", report.enabled && report.windowWeeks === 8);
  check("fr met + breached counted", report.totals.frMet >= 1 && report.totals.frBreached >= 1);
  check("res met + breached counted", report.totals.resMet >= 1 && report.totals.resBreached >= 1);
  check("rates computed", report.totals.frRate !== null && report.totals.resRate !== null);
  const highRow = report.byPriority.find((p) => p.priority === "high");
  check("byPriority buckets the two", (highRow?.frMet ?? 0) >= 1 && (highRow?.frBreached ?? 0) >= 1);
  const teamRow = report.byTeam.find((t) => t.teamId === team.id);
  check("byTeam buckets the laned breach", (teamRow?.frBreached ?? 0) >= 1);
  const noTeamRow = report.byTeam.find((t) => t.teamId === null);
  check("byTeam has a No-team bucket", noTeamRow !== undefined && noTeamRow.teamName === "No team");
  check("byWeek rows exist + trends numeric", report.byWeek.length >= 1 && report.byWeek.some((w) => w.avgFrHours !== null));

  const disabled = await upsertSlaPolicy(A, { ...((await getSlaPolicy(A))), enabled: false });
  const offReport = await getSlaReport(A, 8);
  check("disabled policy → enabled:false empty report", offReport.enabled === false && offReport.byWeek.length === 0);
  void disabled;

  // restore policy exactly as found
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
  console.log(failures === 0 ? "\nrouting-v2: ALL PASS" : `\nrouting-v2: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
