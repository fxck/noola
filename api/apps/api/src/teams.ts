import { withTenant } from "@repo/db";
import type { PoolClient } from "pg";

// Teams (Wave 3) — named agent groups. A team is three things at once: an inbox lane
// (tickets.team_id), an assignment target (assign the lane, optionally round-robin a person
// from it), and a routing pool (routing rules / the `assign` automation action draw candidates
// from its membership). Membership writes are full-replace inside one txn — simple and
// idempotent, no diff bookkeeping.

export interface Team {
  id: string;
  name: string;
  emoji: string | null;
  memberIds: string[];
  memberCount: number;
  openCount: number;
  created_at: string;
}

export interface TeamInput {
  name: string;
  emoji?: string | null;
  memberIds?: string[];
}

const TEAM_COLS = `t.id, t.name, t.emoji, t.created_at,
  COALESCE((SELECT array_agg(tm.user_id ORDER BY tm.created_at)
              FROM team_members tm WHERE tm.tenant_id = t.tenant_id AND tm.team_id = t.id),
           '{}'::uuid[]) AS member_ids,
  (SELECT count(*)::int FROM tickets k
     WHERE k.tenant_id = t.tenant_id AND k.team_id = t.id AND k.status = 'open') AS open_count`;

function rowToTeam(r: Record<string, unknown>): Team {
  const memberIds = (r.member_ids as string[]) ?? [];
  return {
    id: r.id as string,
    name: r.name as string,
    emoji: (r.emoji as string | null) ?? null,
    memberIds,
    memberCount: memberIds.length,
    openCount: Number(r.open_count ?? 0),
    created_at: r.created_at as string,
  };
}

export async function listTeams(tenantId: string): Promise<Team[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(`SELECT ${TEAM_COLS} FROM teams t ORDER BY t.name`);
    return r.rows.map(rowToTeam);
  });
}

export async function getTeam(tenantId: string, id: string): Promise<Team | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(`SELECT ${TEAM_COLS} FROM teams t WHERE t.id = $1`, [id]);
    return r.rowCount ? rowToTeam(r.rows[0]) : null;
  });
}

async function replaceMembers(c: PoolClient, teamId: string, memberIds: string[]): Promise<void> {
  await c.query("DELETE FROM team_members WHERE team_id = $1", [teamId]);
  if (memberIds.length > 0) {
    // The composite FK to users guards against foreign ids; dedupe so a repeated id
    // doesn't violate the PK.
    await c.query(
      `INSERT INTO team_members (tenant_id, team_id, user_id)
       SELECT current_tenant(), $1, x FROM unnest($2::uuid[]) AS x
       ON CONFLICT DO NOTHING`,
      [teamId, memberIds],
    );
  }
}

/** Duplicate team name (case-insensitive) — surfaced as 409 by the route. */
export class DuplicateTeamError extends Error {}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === "23505";
}

export async function createTeam(tenantId: string, input: TeamInput): Promise<Team> {
  try {
    return await withTenant(tenantId, async (c) => {
      const r = await c.query(
        `INSERT INTO teams (tenant_id, name, emoji) VALUES (current_tenant(), $1, $2)
         RETURNING id`,
        [input.name.trim(), input.emoji ?? null],
      );
      const id = r.rows[0].id as string;
      await replaceMembers(c, id, input.memberIds ?? []);
      const out = await c.query(`SELECT ${TEAM_COLS} FROM teams t WHERE t.id = $1`, [id]);
      return rowToTeam(out.rows[0]);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new DuplicateTeamError(`team "${input.name}" already exists`);
    throw err;
  }
}

export async function updateTeam(
  tenantId: string,
  id: string,
  patch: Partial<TeamInput>,
): Promise<Team | null> {
  try {
    return await withTenant(tenantId, async (c) => {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (patch.name !== undefined) { params.push(patch.name.trim()); sets.push(`name = $${params.length}`); }
      if (patch.emoji !== undefined) { params.push(patch.emoji); sets.push(`emoji = $${params.length}`); }
      if (sets.length > 0) {
        params.push(id);
        const r = await c.query(`UPDATE teams SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING id`, params);
        if (!r.rowCount) return null;
      } else {
        const r = await c.query("SELECT id FROM teams WHERE id = $1", [id]);
        if (!r.rowCount) return null;
      }
      if (patch.memberIds !== undefined) await replaceMembers(c, id, patch.memberIds);
      const out = await c.query(`SELECT ${TEAM_COLS} FROM teams t WHERE t.id = $1`, [id]);
      return rowToTeam(out.rows[0]);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new DuplicateTeamError(`team name already in use`);
    throw err;
  }
}

/** Delete a team. Tickets in its lane fall back to no-team (FK SET NULL(team_id));
 *  routing rules that targeted it lose the target the same way. */
export async function deleteTeam(tenantId: string, id: string): Promise<boolean> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query("DELETE FROM teams WHERE id = $1", [id]);
    return (r.rowCount ?? 0) > 0;
  });
}

/** Member ids of one team, on an existing tenant-scoped client — the pool source for
 *  team-targeted assignment (resolveAssignee callers). */
export async function teamMemberIds(c: PoolClient, teamId: string): Promise<string[]> {
  const r = await c.query(
    "SELECT user_id FROM team_members WHERE team_id = $1 ORDER BY created_at",
    [teamId],
  );
  return r.rows.map((x) => x.user_id as string);
}
