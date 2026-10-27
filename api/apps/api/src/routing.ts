import { withTenant } from "@repo/db";
import { projectRoutingRules } from "./seedflows.js";

// Routing & assignment rules — auto-assign (and optionally prioritise/tag) a brand-new ticket
// the moment it lands. A tenant defines an ordered list of rules; the FIRST whose conditions
// match wins. Assignment strategy is one of:
//   • specific     — always the named agent
//   • round_robin  — cycle through a pool (a per-rule cursor persists the position)
//   • least_loaded — the pool member with the fewest OPEN assigned tickets right now
// Conditions are ANDed; an empty condition list is a catch-all.
//
// Dogfood L2: this module is now the EDITOR only. Dispatch moved to the automations engine —
// every mutation below re-projects the rules into managed seed automations (projectRoutingRules),
// and ingest fires `ticket.created` which the engine matches (first-match via `stop`). The old
// bespoke applyRouting evaluator was retired; round_robin/least_loaded live on as the `assign`
// action's primitives (assignments.ts).

export type RoutingOp = "eq" | "contains";
export interface RoutingCondition {
  field: "channel" | "subject" | "priority" | "tag";
  op: RoutingOp;
  value: string;
}
export type RoutingStrategy = "specific" | "round_robin" | "least_loaded";

export interface RoutingRule {
  id: string;
  name: string;
  position: number;
  enabled: boolean;
  conditions: RoutingCondition[];
  strategy: RoutingStrategy;
  assignee_ids: string[];
  /** Target team lane+pool (assignee_ids ignored when set); null = classic agent-pool rule. */
  team_id: string | null;
  /** Skill gate (Routing v2): pool candidates must carry EVERY listed skill. */
  required_skills: string[];
  set_priority: string | null;
  add_tags: string[];
  created_at: string;
}

export interface RoutingRuleInput {
  name: string;
  enabled?: boolean;
  conditions?: RoutingCondition[];
  strategy?: RoutingStrategy;
  assigneeIds?: string[];
  teamId?: string | null;
  requiredSkills?: string[];
  setPriority?: string | null;
  addTags?: string[];
  position?: number;
}

const RULE_COLS = `id, name, position, enabled, conditions, strategy, assignee_ids, team_id, required_skills, set_priority, add_tags, created_at`;

function rowToRule(r: Record<string, unknown>): RoutingRule {
  return {
    id: r.id as string,
    name: r.name as string,
    position: r.position as number,
    enabled: r.enabled as boolean,
    conditions: (r.conditions as RoutingCondition[]) ?? [],
    strategy: r.strategy as RoutingStrategy,
    assignee_ids: (r.assignee_ids as string[]) ?? [],
    team_id: (r.team_id as string | null) ?? null,
    required_skills: (r.required_skills as string[]) ?? [],
    set_priority: (r.set_priority as string | null) ?? null,
    add_tags: (r.add_tags as string[]) ?? [],
    created_at: r.created_at as string,
  };
}

export async function listRoutingRules(tenantId: string): Promise<RoutingRule[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(`SELECT ${RULE_COLS} FROM routing_rules ORDER BY position ASC, created_at ASC`);
    return r.rows.map(rowToRule);
  });
}

export async function createRoutingRule(tenantId: string, input: RoutingRuleInput): Promise<RoutingRule> {
  const rule = await withTenant(tenantId, async (c) => {
    // Append to the end of the ordered list unless a position was given.
    const posR = await c.query(`SELECT COALESCE(max(position), -1) + 1 AS next FROM routing_rules`);
    const position = input.position ?? (posR.rows[0].next as number);
    const r = await c.query(
      `INSERT INTO routing_rules
         (tenant_id, name, position, enabled, conditions, strategy, assignee_ids, team_id, required_skills, set_priority, add_tags)
       VALUES (current_tenant(), $1, $2, COALESCE($3, true), $4::jsonb, $5, $6::uuid[], $7, $8::text[], $9, $10::text[])
       RETURNING ${RULE_COLS}`,
      [
        input.name,
        position,
        input.enabled ?? null,
        JSON.stringify(input.conditions ?? []),
        input.strategy ?? "round_robin",
        input.assigneeIds ?? [],
        input.teamId ?? null,
        input.requiredSkills ?? [],
        input.setPriority ?? null,
        input.addTags ?? [],
      ],
    );
    return rowToRule(r.rows[0]);
  });
  await projectRoutingRules(tenantId); // re-project so the engine dispatches the updated rule set
  return rule;
}

export async function updateRoutingRule(
  tenantId: string,
  id: string,
  patch: Partial<RoutingRuleInput>,
): Promise<RoutingRule | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, val: unknown) => { params.push(val); sets.push(sql.replace("$?", `$${params.length}`)); };
  if (patch.name !== undefined) add("name = $?", patch.name);
  if (patch.enabled !== undefined) add("enabled = $?", patch.enabled);
  if (patch.conditions !== undefined) add("conditions = $?::jsonb", JSON.stringify(patch.conditions));
  if (patch.strategy !== undefined) add("strategy = $?", patch.strategy);
  if (patch.assigneeIds !== undefined) add("assignee_ids = $?::uuid[]", patch.assigneeIds);
  if (patch.teamId !== undefined) add("team_id = $?", patch.teamId);
  if (patch.requiredSkills !== undefined) add("required_skills = $?::text[]", patch.requiredSkills);
  if (patch.setPriority !== undefined) add("set_priority = $?", patch.setPriority);
  if (patch.addTags !== undefined) add("add_tags = $?::text[]", patch.addTags);
  if (patch.position !== undefined) add("position = $?", patch.position);
  if (sets.length === 0) {
    const rules = await listRoutingRules(tenantId);
    return rules.find((r) => r.id === id) ?? null;
  }
  params.push(id);
  const rule = await withTenant(tenantId, async (c) => {
    const r = await c.query(
      `UPDATE routing_rules SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING ${RULE_COLS}`,
      params,
    );
    return r.rowCount ? rowToRule(r.rows[0]) : null;
  });
  if (rule) await projectRoutingRules(tenantId); // re-project the updated rule set
  return rule;
}

export async function deleteRoutingRule(tenantId: string, id: string): Promise<boolean> {
  const gone = await withTenant(tenantId, async (c) => {
    const r = await c.query(`DELETE FROM routing_rules WHERE id = $1`, [id]);
    return (r.rowCount ?? 0) > 0;
  });
  if (gone) await projectRoutingRules(tenantId); // re-project without the deleted rule
  return gone;
}

// (applyRouting + its helpers retired — dispatch now runs through the automations engine via the
//  projected seed automations. See seedflows.ts:projectRoutingRules and the `assign` action.)
