import { withTenant, relayPool } from "@repo/db";
import type { AutomationAction, AutomationCondition, AutomationConditionOp } from "@repo/contracts";
import { DEFAULT_TAG_RULES } from "./autotag.js";

// Dogfood L2 — project the bespoke Settings forms (routing rules, survey toggles) into MANAGED
// seed automations, so the product's own engine dispatches them instead of hand-written modules.
// Progressive disclosure (LOCKED): the Settings pages keep working identically; underneath, every
// write regenerates the tenant's managed automations (full-replace, idempotent). The Studio list
// badges these rows "Managed in Settings"; graduating (POST /automations/:id/graduate) clears
// managed_by and the projection stops overwriting it.
//
// Self-contained by design: reads routing_rules / survey_settings directly (no import of
// routing.ts / surveys.ts) so those modules can import THIS one to fire projection on write
// without an import cycle.

type Priority = "low" | "normal" | "high" | "urgent";

// ── Routing → seed automations (trigger: ticket.created) ──────────────────────
// Each enabled routing rule becomes one linear automation, in position order, ending with `stop`
// so the engine's first-match-wins matches routing's "first rule whose conditions match wins".
// The ticket is always unassigned at creation, so the old "only if unassigned" guard is implicit
// (no branch needed). The round-robin cursor is keyed by the rule id, so it survives re-projection.

interface RoutingRuleRow {
  id: string;
  name: string;
  enabled: boolean;
  conditions: Array<{ field: string; op: string; value: string }>;
  strategy: "specific" | "round_robin" | "least_loaded";
  assignee_ids: string[];
  team_id: string | null;
  required_skills: string[];
  set_priority: string | null;
  add_tags: string[];
}

/** Map one routing condition (field ∈ channel|subject|priority|tag, op ∈ eq|contains) to an
 *  automation condition over the hydrated context. */
function mapCondition(c: { field: string; op: string; value: string }): AutomationCondition {
  const op: AutomationConditionOp = c.op === "contains" ? "contains" : "equals";
  switch (c.field) {
    case "channel": return { field: "channelType", op, value: c.value };
    case "subject": return { field: "subject", op, value: c.value };
    case "priority": return { field: "priority", op: "equals", value: c.value };
    case "tag": return { field: "tags", op: "contains_any", value: c.value };
    default: return { field: c.field, op, value: c.value };
  }
}

function routingActions(rule: RoutingRuleRow): AutomationAction[] {
  const actions: AutomationAction[] = [];
  if (rule.set_priority) actions.push({ type: "set_priority", priority: rule.set_priority as Priority });
  if (rule.add_tags.length > 0) actions.push({ type: "add_tags", tags: rule.add_tags });
  // A team target lands the ticket in the team's lane and pools its members (specific makes no
  // sense for a team — treat it as round_robin at execution).
  const skills = rule.required_skills?.length ? { requiredSkills: rule.required_skills } : {};
  actions.push(
    rule.team_id
      ? { type: "assign", strategy: rule.strategy === "specific" ? "round_robin" : rule.strategy, teamId: rule.team_id, cursorKey: `routing:${rule.id}`, ...skills }
      : rule.strategy === "specific"
        ? { type: "assign", strategy: "specific", assigneeId: rule.assignee_ids[0] ?? null }
        : { type: "assign", strategy: rule.strategy, assigneeIds: rule.assignee_ids, cursorKey: `routing:${rule.id}`, ...skills },
  );
  actions.push({ type: "stop" });
  return actions;
}

/** Regenerate the tenant's routing-managed automations from the current routing_rules. Call after
 *  every routing_rules mutation. Full-replace inside one txn (delete managed 'routing' rows, then
 *  reinsert enabled rules in position order). */
export async function projectRoutingRules(tenantId: string): Promise<void> {
  await withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT id, name, enabled, conditions, strategy, assignee_ids, team_id, required_skills, set_priority, add_tags
         FROM routing_rules WHERE enabled = true ORDER BY position ASC, created_at ASC`,
    );
    const rules = r.rows as RoutingRuleRow[];
    await c.query("DELETE FROM automations WHERE managed_by = 'routing'");
    for (const rule of rules) {
      const conditions = {
        match: "all" as const,
        conditions: (rule.conditions ?? []).map(mapCondition),
      };
      await c.query(
        `INSERT INTO automations (tenant_id, name, enabled, trigger_event, conditions, actions, managed_by)
         VALUES (current_tenant(), $1, true, 'ticket.created', $2::jsonb, $3::jsonb, 'routing')`,
        [rule.name, JSON.stringify(conditions), JSON.stringify(routingActions(rule))],
      );
    }
  });
}

// ── Survey toggles → a seed automation (trigger: ticket.closed) ───────────────

/** Regenerate the tenant's survey-managed automation from survey_settings. One catch-all
 *  ticket.closed → survey automation when either toggle is on; none when both are off. */
export async function projectSurveys(tenantId: string): Promise<void> {
  await withTenant(tenantId, async (c) => {
    const s = await c.query("SELECT csat_enabled, nps_enabled FROM survey_settings LIMIT 1");
    const csat = Boolean(s.rows[0]?.csat_enabled);
    const nps = Boolean(s.rows[0]?.nps_enabled);
    await c.query("DELETE FROM automations WHERE managed_by = 'surveys'");
    if (!csat && !nps) return;
    const surveyKind = csat && nps ? "both" : csat ? "csat" : "nps";
    const actions: AutomationAction[] = [{ type: "survey", surveyKind }];
    await c.query(
      `INSERT INTO automations (tenant_id, name, enabled, trigger_event, conditions, actions, managed_by)
       VALUES (current_tenant(), 'Satisfaction survey', true, 'ticket.closed',
               '{"match":"all","conditions":[]}'::jsonb, $1::jsonb, 'surveys')`,
      [JSON.stringify(actions)],
    );
  });
}

// ── Auto-tagging → ONE seed automation (trigger: ticket.created) ──────────────
// The keyword→tag mapping is R2 config (the tag_rules table, edited in Settings → Auto-tagging) —
// NOT one flow per tag. It projects into a SINGLE managed automation "Auto-tagging" whose
// `apply_tag_rules` action reads the whole keyword table live (so Settings edits take effect with no
// re-projection), followed by `ai_tag` when tag_settings.ai_enabled. One transparent, forkable row.
//
// Ordering guarantee: tagging must run even when a routing rule (also ticket.created) first-match
// `stop`s the engine. The managed 'autotag' row is inserted with a fixed year-2000 created_at, so
// the engine (ORDER BY created_at ASC) runs it BEFORE any routing row (which uses now()).
const AUTOTAG_EPOCH = "2000-01-01T00:00:00Z";

/** Install the built-in tag rules + settings for a tenant that has none yet. Idempotent: seeds only
 *  on the FIRST tag_settings insert (a row's presence marks "defaults installed"), so a tenant who
 *  deletes every rule stays empty rather than having the defaults re-added. */
export async function ensureTagDefaults(tenantId: string): Promise<void> {
  await withTenant(tenantId, async (c) => {
    const ins = await c.query(
      `INSERT INTO tag_settings (tenant_id) VALUES (current_tenant())
       ON CONFLICT (tenant_id) DO NOTHING RETURNING tenant_id`,
    );
    if (!ins.rowCount) return; // already initialised — respect the tenant's current rule set
    for (let i = 0; i < DEFAULT_TAG_RULES.length; i++) {
      const r = DEFAULT_TAG_RULES[i];
      await c.query(
        `INSERT INTO tag_rules (tenant_id, tag, keywords, enabled, position)
         VALUES (current_tenant(), $1, $2, true, $3)`,
        [r.tag, r.keywords, i],
      );
    }
  });
}

/** Regenerate the tenant's single autotag-managed automation from tag_settings. Full-replace inside
 *  one txn. Call after a tag-config mutation (and on boot backfill). The keyword rules themselves are
 *  read live by `apply_tag_rules`, so editing them needs no re-projection — only the AI toggle and
 *  the flow's existence are projected here. */
export async function projectAutotag(tenantId: string): Promise<void> {
  await withTenant(tenantId, async (c) => {
    const hasRules = (await c.query("SELECT 1 FROM tag_rules WHERE enabled = true LIMIT 1")).rowCount ?? 0;
    const s = await c.query("SELECT ai_enabled FROM tag_settings LIMIT 1");
    const aiEnabled = s.rowCount ? Boolean(s.rows[0].ai_enabled) : true;

    await c.query("DELETE FROM automations WHERE managed_by = 'autotag'");

    // Nothing to do when there are no keyword rules and AI is off.
    if (!hasRules && !aiEnabled) return;

    const actions: AutomationAction[] = [];
    if (hasRules) actions.push({ type: "apply_tag_rules" });
    if (aiEnabled) actions.push({ type: "ai_tag" });
    await c.query(
      `INSERT INTO automations (tenant_id, name, enabled, trigger_event, conditions, actions, managed_by, created_at)
       VALUES (current_tenant(), 'Auto-tagging', true, 'ticket.created',
               '{"match":"all","conditions":[]}'::jsonb, $1::jsonb, 'autotag',
               TIMESTAMPTZ '${AUTOTAG_EPOCH}')`,
      [JSON.stringify(actions)],
    );
  });
}

// ── Boot backfill ─────────────────────────────────────────────────────────────
// Existing tenants have routing_rules / survey_settings but no projected automations yet. On boot,
// project every tenant that has either, so behaviour continues with zero re-save. Idempotent
// full-replace, so re-running is safe. Cross-tenant enumeration uses the BYPASSRLS relay pool.

type BootLog = { info?: (...a: unknown[]) => void; error?: (...a: unknown[]) => void };

export async function backfillSeedFlows(log?: BootLog): Promise<void> {
  try {
    const routingTenants = await relayPool.query("SELECT DISTINCT tenant_id FROM routing_rules");
    const surveyTenants = await relayPool.query("SELECT tenant_id FROM survey_settings WHERE csat_enabled OR nps_enabled");
    for (const row of routingTenants.rows) {
      try { await projectRoutingRules(row.tenant_id as string); }
      catch (e) { log?.error?.({ err: e, tenantId: row.tenant_id }, "routing seed-flow backfill failed"); }
    }
    for (const row of surveyTenants.rows) {
      try { await projectSurveys(row.tenant_id as string); }
      catch (e) { log?.error?.({ err: e, tenantId: row.tenant_id }, "survey seed-flow backfill failed"); }
    }
    // Auto-tagging is ALWAYS-ON (it used to run unconditionally in ingest), so install defaults +
    // project for EVERY tenant, not just those that touched a settings form. Enumerate the org list
    // on the BYPASSRLS relay pool (tenant_id == organization.id).
    const orgs = await relayPool.query('SELECT id FROM "organization"');
    for (const row of orgs.rows) {
      try { await ensureTagDefaults(row.id as string); await projectAutotag(row.id as string); }
      catch (e) { log?.error?.({ err: e, tenantId: row.id }, "autotag seed-flow backfill failed"); }
    }
    log?.info?.(
      { routingTenants: routingTenants.rowCount, surveyTenants: surveyTenants.rowCount, orgs: orgs.rowCount },
      "seed-flow projection backfill complete",
    );
  } catch (e) {
    log?.error?.({ err: e }, "seed-flow projection backfill failed");
  }
}
