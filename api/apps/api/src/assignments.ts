import type { PoolClient } from "pg";
import { withTenant } from "@repo/db";
import { teamMemberIds } from "./teams.js";

// Assignee-resolution primitives (dogfood L1) — the atomic bodies behind the strategy-aware
// `assign` flow action. These are code, not flows (stateful cursor / aggregate query): a flow
// CALLS them. Operate on an EXISTING tenant-scoped client so the cursor bump + the assignment
// land in one transaction (the round-robin atomicity the old routing.ts guarded inline).

export type AssignStrategy = "specific" | "round_robin" | "least_loaded";

export interface ResolveAssigneeOpts {
  strategy: AssignStrategy;
  /** Pool for the round_robin / least_loaded strategies. Empty = every agent in the tenant. */
  assigneeIds?: string[];
  /** The single target for the `specific` strategy (falls back to assigneeIds[0]). */
  specificId?: string | null;
  /** Team pool: candidates are the team's members (assigneeIds is ignored). An empty team
   *  resolves to null — the ticket stays in the team lane unassigned. */
  teamId?: string | null;
  /** Round-robin cursor scope — a stable key (e.g. 'routing:<ruleId>') so independent rules
   *  keep independent positions. Ignored by the other strategies. */
  cursorKey: string;
  /** Skill gate (Routing v2): pool candidates must carry EVERY listed skill. */
  requiredSkills?: string[];
}

/** Routing v2 pool eligibility: drop out-of-office agents, agents at/over their open-ticket
 *  load cap, and (when the rule demands skills) agents missing any required skill. Applied to
 *  POOL strategies only — a `specific` assignment is an explicit human choice and bypasses it.
 *  May return [] (nobody eligible) — the caller leaves the ticket unassigned. */
async function eligiblePool(c: PoolClient, pool: string[], requiredSkills: string[]): Promise<string[]> {
  if (pool.length === 0) return pool;
  const r = await c.query(
    `SELECT u.id
       FROM unnest($1::uuid[]) AS p(id)
       JOIN users u ON u.id = p.id
       LEFT JOIN (
         SELECT assignee_id, count(*) AS n FROM tickets
          WHERE status = 'open' AND assignee_id = ANY($1::uuid[])
          GROUP BY assignee_id
       ) cnt ON cnt.assignee_id = u.id
      WHERE NOT (u.out_of_office AND (u.ooo_until IS NULL OR u.ooo_until > now()))
        AND u.skills @> $2::text[]
        AND (u.max_open_tickets IS NULL OR COALESCE(cnt.n, 0) < u.max_open_tickets)
      ORDER BY array_position($1::uuid[], u.id)`,
    [pool, requiredSkills],
  );
  return r.rows.map((x) => x.id as string);
}

/** Resolve an assignee within an existing tenant transaction. Returns the chosen user id, or null
 *  when no candidate exists (empty pool + no users). Round-robin persists its position in
 *  assignment_cursors atomically with the caller's txn; least_loaded is a pure aggregate. */
export async function resolveAssignee(c: PoolClient, opts: ResolveAssigneeOpts): Promise<string | null> {
  if (opts.strategy === "specific") {
    return opts.specificId ?? opts.assigneeIds?.[0] ?? null;
  }

  // Pool: the team's members when a team is the target; else the given list, or every agent
  // when the list is empty (mirrors routing's default). An empty TEAM does not widen to all
  // agents — the ticket stays unassigned in the team lane.
  let pool: string[];
  if (opts.teamId) {
    pool = await teamMemberIds(c, opts.teamId);
  } else {
    pool = (opts.assigneeIds ?? []).filter(Boolean);
    if (pool.length === 0) {
      const u = await c.query("SELECT id FROM users ORDER BY name");
      pool = u.rows.map((x) => x.id as string);
    }
  }
  pool = await eligiblePool(c, pool, opts.requiredSkills ?? []);
  if (pool.length === 0) return null;

  if (opts.strategy === "round_robin") {
    // Atomic bump: upsert the cursor and return its PREVIOUS value, so concurrent creates on the
    // same key never hand out the same slot twice.
    const cr = await c.query(
      `INSERT INTO assignment_cursors (tenant_id, key, cursor) VALUES (current_tenant(), $1, 1)
       ON CONFLICT (tenant_id, key) DO UPDATE SET cursor = assignment_cursors.cursor + 1, updated_at = now()
       RETURNING cursor - 1 AS prev`,
      [opts.cursorKey],
    );
    const prev = Number(cr.rows[0]?.prev ?? 0);
    return pool[((prev % pool.length) + pool.length) % pool.length];
  }

  // least_loaded: the pool member with the fewest OPEN assigned tickets right now (0 for anyone
  // with no current load — the LEFT JOIN keeps them in the running).
  const lr = await c.query(
    `SELECT p.id
       FROM unnest($1::uuid[]) AS p(id)
       LEFT JOIN (
         SELECT assignee_id, count(*) AS n FROM tickets
          WHERE status = 'open' AND assignee_id = ANY($1::uuid[])
          GROUP BY assignee_id
       ) cnt ON cnt.assignee_id = p.id
      ORDER BY COALESCE(cnt.n, 0) ASC, p.id ASC
      LIMIT 1`,
    [pool],
  );
  return (lr.rows[0]?.id as string) ?? null;
}

// ── Routing v2: per-agent routing signals + the OOO hand-back ─────────────────

export interface UserRouting {
  id: string;
  skills: string[];
  out_of_office: boolean;
  ooo_until: string | null;
  max_open_tickets: number | null;
}

/** Read-repair: clear expired OOO flags (tenant-scoped — event_relay can't write users).
 *  Callers that LIST agents run this first so badges auto-return; pool eligibility doesn't
 *  need it (it checks the expiry inline). */
export async function clearExpiredOoo(c: PoolClient): Promise<void> {
  await c.query("UPDATE users SET out_of_office = false, ooo_until = NULL WHERE out_of_office AND ooo_until <= now()");
}

/** Update one agent's routing signals (admin). Returns null when the user is absent. */
export async function updateUserRouting(
  tenantId: string,
  userId: string,
  patch: { skills?: string[]; outOfOffice?: boolean; oooUntil?: string | null; maxOpenTickets?: number | null },
): Promise<UserRouting | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, val: unknown) => { params.push(val); sets.push(sql.replace("$?", `$${params.length}`)); };
  if (patch.skills !== undefined) add("skills = $?::text[]", patch.skills.map((s) => s.trim()).filter(Boolean));
  if (patch.outOfOffice !== undefined) {
    add("out_of_office = $?", patch.outOfOffice);
    // Turning OOO off always clears the return time; turning it on without an explicit
    // oooUntil clears any stale one (indefinite).
    if (patch.oooUntil === undefined) sets.push("ooo_until = NULL");
  }
  if (patch.oooUntil !== undefined) {
    const t = patch.oooUntil ? new Date(patch.oooUntil) : null;
    add("ooo_until = $?", t && !Number.isNaN(t.getTime()) ? t.toISOString() : null);
  }
  if (patch.maxOpenTickets !== undefined) add("max_open_tickets = $?", patch.maxOpenTickets);
  return withTenant(tenantId, async (c) => {
    if (sets.length === 0) {
      const r = await c.query("SELECT id, skills, out_of_office, ooo_until, max_open_tickets FROM users WHERE id = $1", [userId]);
      return r.rowCount ? (r.rows[0] as UserRouting) : null;
    }
    params.push(userId);
    const r = await c.query(
      `UPDATE users SET ${sets.join(", ")} WHERE id = $${params.length}
       RETURNING id, skills, out_of_office, ooo_until, max_open_tickets`,
      params,
    );
    return r.rowCount ? (r.rows[0] as UserRouting) : null;
  });
}

/** Hand back an agent's open queue (the OOO one-shot): team-laned tickets round-robin to an
 *  ELIGIBLE teammate (the eligibility filter already excludes the now-OOO agent); the rest go
 *  back to Unassigned. Returns {reassigned, unassigned}. Call AFTER flipping out_of_office so
 *  the filter sees the new state. */
export async function reassignOpenTickets(
  tenantId: string,
  userId: string,
): Promise<{ reassigned: number; unassigned: number }> {
  return withTenant(tenantId, async (c) => {
    const open = await c.query(
      "SELECT id, team_id FROM tickets WHERE assignee_id = $1 AND status = 'open' ORDER BY created_at",
      [userId],
    );
    let reassigned = 0;
    let unassigned = 0;
    for (const row of open.rows as { id: string; team_id: string | null }[]) {
      let next: string | null = null;
      if (row.team_id) {
        next = await resolveAssignee(c, {
          strategy: "round_robin",
          teamId: row.team_id,
          cursorKey: `team:${row.team_id}`,
        });
        if (next === userId) next = null; // safety: never hand a ticket back to the leaver
      }
      await c.query("UPDATE tickets SET assignee_id = $1, updated_at = now() WHERE id = $2", [next, row.id]);
      if (next) reassigned++; else unassigned++;
    }
    return { reassigned, unassigned };
  });
}
