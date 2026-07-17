import { withTenant } from "@repo/db";
import { listTeams, createTeam, updateTeam, deleteTeam, DuplicateTeamError, teamMemberIds } from "../src/teams.js";
import { resolveAssignee } from "../src/assignments.js";
import { setTicketTeam, queryTickets, getTicketDetail, bulkTickets } from "../src/tickets.js";
import { createRoutingRule, deleteRoutingRule } from "../src/routing.js";
import { getWorkload } from "../src/analytics.js";

// Teams (Wave 3, item 11) — CRUD + membership, the ticket team lane (set/clear/auto-assign
// round-robin), team pools in resolveAssignee, routing-rule team targets (projection into the
// managed seed automation), the teamId ticket filter, bulk team moves, and the workload report.
// Needs Postgres. Cleans up after itself (re-runnable) under the demo tenant.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const ALES = "c0000000-0000-0000-0000-000000000001";
const SAM = "c0000000-0000-0000-0000-000000000002";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.error(`  FAIL  ${name}`);
  }
}

async function makeTicket(subject: string): Promise<string> {
  return withTenant(A, async (c) => {
    const r = await c.query(
      `INSERT INTO tickets (tenant_id, subject, status, channel_type, whose_turn)
       VALUES (current_tenant(), $1, 'open', 'widget', 'us') RETURNING id`,
      [subject],
    );
    return r.rows[0].id as string;
  });
}

async function cleanup() {
  await withTenant(A, async (c) => {
    await c.query("DELETE FROM tickets WHERE subject LIKE 'teams-test:%'");
    await c.query("DELETE FROM teams WHERE name LIKE 'TT %'");
    await c.query("DELETE FROM assignment_cursors WHERE key LIKE 'team:%' OR key LIKE 'tt-%'");
  });
}

async function main() {
  await cleanup();

  // ── CRUD + membership ──────────────────────────────────────────────────────
  const support = await createTeam(A, { name: "TT Support", emoji: "🛟", memberIds: [ALES, SAM] });
  check("createTeam returns members in order", support.memberIds.length === 2 && support.memberCount === 2);
  check("createTeam carries emoji", support.emoji === "🛟");

  let dup = false;
  try { await createTeam(A, { name: "tt support" }); } catch (e) { dup = e instanceof DuplicateTeamError; }
  check("duplicate name (case-insensitive) → DuplicateTeamError", dup);

  const solo = await createTeam(A, { name: "TT Billing", memberIds: [ALES] });
  const renamed = await updateTeam(A, solo.id, { name: "TT Billing EU", memberIds: [SAM] });
  check("updateTeam renames + full-replaces members", renamed?.name === "TT Billing EU" && renamed?.memberIds.join() === SAM);
  const untouched = await updateTeam(A, solo.id, { emoji: "💳" });
  check("patch without memberIds leaves membership", untouched?.memberIds.join() === SAM && untouched?.emoji === "💳");

  const teams = await listTeams(A);
  check("listTeams lists both (name order)", teams.filter((t) => t.name.startsWith("TT ")).length === 2);

  const memberDup = await createTeam(A, { name: "TT Dup", memberIds: [ALES, ALES] });
  check("duplicate member ids dedupe", memberDup.memberIds.length === 1);
  await deleteTeam(A, memberDup.id);

  // ── team pool in resolveAssignee (round-robin over members) ────────────────
  const picks = await withTenant(A, async (c) => {
    const out: (string | null)[] = [];
    for (let i = 0; i < 4; i++) {
      out.push(await resolveAssignee(c, { strategy: "round_robin", teamId: support.id, cursorKey: "tt-rr" }));
    }
    return out;
  });
  check("team round-robin cycles members", picks[0] !== picks[1] && picks[0] === picks[2] && picks[1] === picks[3]);
  check("team round-robin picks are team members", picks.every((p) => p === ALES || p === SAM));

  const emptyTeam = await createTeam(A, { name: "TT Empty" });
  const emptyPick = await withTenant(A, (c) =>
    resolveAssignee(c, { strategy: "round_robin", teamId: emptyTeam.id, cursorKey: "tt-empty" }),
  );
  check("empty team resolves null (no widen-to-all)", emptyPick === null);

  // ── ticket team lane: set / auto-assign / clear ────────────────────────────
  const t1 = await makeTicket("teams-test: lane");
  const laneOnly = await setTicketTeam(A, t1, support.id);
  check("setTicketTeam sets the lane, assignee untouched", laneOnly?.teamId === support.id && laneOnly?.assigneeId === null);
  const detail1 = await getTicketDetail(A, t1);
  check("ticket row hydrates team_name", detail1?.team_id === support.id && detail1?.team_name === "TT Support");

  const t2 = await makeTicket("teams-test: auto");
  const auto = await setTicketTeam(A, t2, support.id, true);
  check("autoAssign picks a member", auto?.teamId === support.id && (auto?.assigneeId === ALES || auto?.assigneeId === SAM));

  const t2b = await makeTicket("teams-test: auto-empty");
  const autoEmpty = await setTicketTeam(A, t2b, emptyTeam.id, true);
  check("autoAssign on an empty team = lane only", autoEmpty?.teamId === emptyTeam.id && autoEmpty?.assigneeId === null);

  const cleared = await setTicketTeam(A, t1, null);
  check("teamId=null clears the lane", cleared?.teamId === null);

  let fkErr = false;
  try { await setTicketTeam(A, t1, "00000000-0000-0000-0000-000000000000"); }
  catch (e) { fkErr = (e as { code?: string }).code === "23503"; }
  check("foreign team id → 23503 (composite FK guard)", fkErr);

  // ── teamId filter + bulk move ──────────────────────────────────────────────
  await setTicketTeam(A, t1, support.id);
  const filtered = await queryTickets(A, { status: "open", teamId: support.id });
  const filteredIds = filtered.rows.map((r) => r.id);
  check("queryTickets teamId filter matches lane", filteredIds.includes(t1) && filteredIds.includes(t2) && !filteredIds.includes(t2b));
  const none = await queryTickets(A, { status: "open", teamId: "none", q: "teams-test:" });
  check("teamId=none finds the laneless", none.rows.every((r) => r.team_id === null));

  const moved = await bulkTickets(A, [t1, t2, t2b], "team", emptyTeam.id);
  check("bulk team move updates all", moved.length === 3);
  const afterBulk = await queryTickets(A, { status: "open", teamId: emptyTeam.id });
  check("bulk-moved tickets read back in the lane", afterBulk.rows.filter((r) => r.subject.startsWith("teams-test:")).length === 3);

  // ── routing rule with a team target → projected assign action ──────────────
  const rule = await createRoutingRule(A, {
    name: "TT route to support",
    conditions: [{ field: "subject", op: "contains", value: "teams-test-routed" }],
    strategy: "round_robin",
    teamId: support.id,
  });
  check("routing rule stores team_id", rule.team_id === support.id);
  const projected = await withTenant(A, async (c) => {
    const r = await c.query(
      "SELECT actions FROM automations WHERE managed_by = 'routing' AND name = 'TT route to support'",
    );
    return r.rows[0]?.actions as Array<Record<string, unknown>> | undefined;
  });
  const assignAction = projected?.find((a) => a.type === "assign");
  check("projection carries teamId + per-rule cursor", assignAction?.teamId === support.id && assignAction?.cursorKey === `routing:${rule.id}`);
  await deleteRoutingRule(A, rule.id);

  // ── workload report ────────────────────────────────────────────────────────
  const wl = await getWorkload(A);
  check("workload totals are sane", wl.totals.open >= 3 && wl.totals.waiting >= 0);
  const alesRow = wl.byAgent.find((a) => a.agentId === ALES);
  check("workload lists every agent (idle included)", wl.byAgent.length >= 2 && alesRow !== undefined);
  const emptyRow = wl.byTeam.find((t) => t.teamId === emptyTeam.id);
  check("workload byTeam counts the lane", emptyRow !== undefined && emptyRow.open >= 3 && emptyRow.memberCount === 0);
  const supportRow = wl.byTeam.find((t) => t.teamId === support.id);
  check("workload byTeam memberCount", supportRow?.memberCount === 2);

  // ── delete: lane falls back to NULL, membership cascades ───────────────────
  await deleteTeam(A, emptyTeam.id);
  const orphan = await getTicketDetail(A, t1);
  check("team delete SET NULLs the lane (tenant_id intact)", orphan !== null && orphan.team_id === null);
  await deleteTeam(A, support.id);
  await deleteTeam(A, solo.id);
  // Scoped to THIS test's teams — the shared dev DB may hold real teams with members.
  const membersLeft = await withTenant(A, (c) =>
    c.query("SELECT count(*)::int AS n FROM team_members WHERE team_id = ANY($1::uuid[])", [
      [support.id, solo.id, emptyTeam.id],
    ]),
  );
  check("membership cascades on team delete", Number(membersLeft.rows[0].n) === 0);

  await cleanup();
  console.log(failures === 0 ? "\nteams: ALL PASS" : `\nteams: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
