import { api } from "@/lib/api";

// Routing & assignment rules — ordered, condition-matched auto-assignment for new tickets.

export const ROUTING_STRATEGIES = ["specific", "round_robin", "least_loaded"] as const;
export type RoutingStrategy = (typeof ROUTING_STRATEGIES)[number];
export const ROUTING_FIELDS = ["channel", "subject", "priority", "tag"] as const;
export type RoutingField = (typeof ROUTING_FIELDS)[number];
export const ROUTING_OPS = ["eq", "contains"] as const;
export type RoutingOp = (typeof ROUTING_OPS)[number];

export interface RoutingCondition {
  field: RoutingField;
  op: RoutingOp;
  value: string;
}

export interface RoutingRule {
  id: string;
  name: string;
  position: number;
  enabled: boolean;
  conditions: RoutingCondition[];
  strategy: RoutingStrategy;
  assignee_ids: string[];
  /** When set the rule targets a team: tickets land in the team's lane and the pool
   *  strategies draw from the team's members; assignee_ids is ignored. */
  team_id: string | null;
  set_priority: string | null;
  add_tags: string[];
  /** Skill gate: pool candidates (agent or team pools) must carry EVERY listed skill;
   *  agents missing one are skipped at assignment time. Empty = no gate. */
  required_skills: string[];
  created_at: string;
}

export interface RoutingRuleInput {
  name: string;
  enabled?: boolean;
  conditions?: RoutingCondition[];
  strategy?: RoutingStrategy;
  assigneeIds?: string[];
  /** Target a team instead of an agent pool (null clears). With a team, "specific"
   *  is meaningless — the api treats it as round_robin. */
  teamId?: string | null;
  setPriority?: string | null;
  addTags?: string[];
  /** Max 10, each ≤40 chars. Empty array clears the gate. */
  requiredSkills?: string[];
  position?: number;
}

export const STRATEGY_LABEL: Record<RoutingStrategy, string> = {
  specific: "Specific agent",
  round_robin: "Round robin",
  least_loaded: "Least loaded",
};

export async function fetchRoutingRules(): Promise<RoutingRule[]> {
  return (await api<{ rules: RoutingRule[] }>("/routing-rules")).rules;
}

export async function createRoutingRule(input: RoutingRuleInput): Promise<RoutingRule> {
  return (await api<{ rule: RoutingRule }>("/routing-rules", { method: "POST", body: JSON.stringify(input) })).rule;
}

export async function updateRoutingRule(id: string, patch: Partial<RoutingRuleInput>): Promise<RoutingRule> {
  return (await api<{ rule: RoutingRule }>(`/routing-rules/${id}`, { method: "PATCH", body: JSON.stringify(patch) })).rule;
}

export async function deleteRoutingRule(id: string): Promise<void> {
  await api<{ ok: true }>(`/routing-rules/${id}`, { method: "DELETE" });
}
