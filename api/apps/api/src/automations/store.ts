import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { withTenant, relayPool } from "@repo/db";
import type {
  AutomationInput,
  AutomationUpdateInput,
  AutomationConditions,
  AutomationAction,
  AutomationTriggerConfig,
  FlowGraph,
} from "@repo/contracts";

// ── Automations persistence ───────────────────────────────────────────────────
// The automations table CRUD, the run-history read side, the pre-tenant webhook_routes routing
// table, and the flow_dedupe at-most-once reservation. Everything RLS-scoped via withTenant except
// webhook_routes, which sits OUTSIDE RLS (resolved pre-tenant on the BYPASSRLS relay pool).

export interface AutomationRow {
  id: string;
  name: string;
  enabled: boolean;
  trigger: string;
  triggerConfig: AutomationTriggerConfig;
  conditions: AutomationConditions;
  actions: AutomationAction[];
  graph: FlowGraph | null;
  /** Monotonic graph version (0081). Bumped every time the graph is saved; a run records the
   *  version it executed, so history is reproducible and a mid-run edit can't rewrite it. */
  version: number;
  runCount: number;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  // For webhook-triggered automations: the token that resolves POST /hooks/:token to this
  // automation (minted on create/update; the FE builds the full URL). Null otherwise.
  webhookToken: string | null;
  // Dogfood L2 — 'routing' | 'surveys' when this row is a seed automation projected from a
  // Settings form (managed, badged read-only in Studio); null for a hand-authored flow.
  managedBy: string | null;
}

/** One entry of a run's per-node trace: which graph node ran, its action type, and outcome.
 *  nodeId is null for linear (non-graph) rules. */
export interface RunTraceEntry {
  nodeId: string | null;
  type: string;
  ok: boolean;
  detail: string;
}

export interface AutomationRunRow {
  id: string;
  automationId: string;
  trigger: string;
  status: string;
  ticketId: string | null;
  actionsResult: unknown;
  trace: RunTraceEntry[];
  error: string | null;
  createdAt: string;
}

const COLS =
  "id, name, enabled, trigger_event, trigger_config, conditions, actions, graph, version, run_count, last_run_at, created_at, updated_at, managed_by";

/** Snapshot the current graph into automation_versions (0081) for reproducible run history. Called
 *  after any save that (re)writes the graph; keyed on (tenant, automation, version) so a re-save at
 *  the same version is idempotent. No-op when the automation has no graph. */
async function snapshotVersion(c: PoolClient, row: AutomationRow): Promise<void> {
  if (!row.graph) return;
  // Version bumps on every graph change, so a (tenant, automation, version) key never carries a
  // different graph → DO NOTHING is safe (and avoids needing UPDATE grant on the table).
  await c.query(
    `INSERT INTO automation_versions (tenant_id, automation_id, version, graph)
     VALUES (current_tenant(), $1, $2, $3::jsonb)
     ON CONFLICT (tenant_id, automation_id, version) DO NOTHING`,
    [row.id, row.version, JSON.stringify(row.graph)],
  );
}

function iso(v: unknown): string | null {
  return v ? new Date(v as string).toISOString() : null;
}

function mapRow(r: Record<string, unknown>): AutomationRow {
  return {
    id: r.id as string,
    name: r.name as string,
    enabled: r.enabled as boolean,
    trigger: r.trigger_event as string,
    triggerConfig: (r.trigger_config as AutomationTriggerConfig) ?? null,
    conditions: (r.conditions as AutomationConditions) ?? { match: "all", conditions: [] },
    actions: (r.actions as AutomationAction[]) ?? [],
    graph: (r.graph as FlowGraph) ?? null,
    version: (r.version as number) ?? 1,
    runCount: (r.run_count as number) ?? 0,
    lastRunAt: iso(r.last_run_at),
    createdAt: iso(r.created_at) as string,
    updatedAt: iso(r.updated_at) as string,
    webhookToken: null, // filled by attachWebhookToken for webhook triggers
    managedBy: (r.managed_by as string) ?? null,
  };
}

// ── webhook_routes: the pre-tenant token→automation routing table (mirrors widget_keys) ───────
// Sits OUTSIDE RLS: POST /hooks/:token resolves the tenant from the token BEFORE any tenant
// context exists, so every query runs on the BYPASSRLS relay pool with an explicit tenant_id
// predicate as the isolation guard on the management path.

function mintWebhookToken(): string {
  return "wh_" + crypto.randomBytes(12).toString("hex"); // wh_ + 24 hex chars
}

/** Ensure a webhook_routes row exists for a webhook-triggered automation; returns its token,
 *  minting one on first call. Idempotent + race-safe via the (tenant_id, automation_id) unique. */
async function ensureWebhookRoute(tenantId: string, automationId: string): Promise<string> {
  const existing = await relayPool.query(
    "SELECT token FROM webhook_routes WHERE tenant_id = $1 AND automation_id = $2",
    [tenantId, automationId],
  );
  if (existing.rowCount) return existing.rows[0].token as string;
  await relayPool.query(
    `INSERT INTO webhook_routes (token, tenant_id, automation_id) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, automation_id) DO NOTHING`,
    [mintWebhookToken(), tenantId, automationId],
  );
  const r = await relayPool.query(
    "SELECT token FROM webhook_routes WHERE tenant_id = $1 AND automation_id = $2",
    [tenantId, automationId],
  );
  return r.rows[0].token as string;
}

async function getWebhookToken(tenantId: string, automationId: string): Promise<string | null> {
  const r = await relayPool.query(
    "SELECT token FROM webhook_routes WHERE tenant_id = $1 AND automation_id = $2",
    [tenantId, automationId],
  );
  return r.rowCount ? (r.rows[0].token as string) : null;
}

/** Resolve a webhook token → {tenantId, automationId} (pre-tenant, BYPASSRLS). Used by the
 *  public POST /hooks/:token lane before any tenant context exists. */
export async function resolveWebhookRoute(
  token: string,
): Promise<{ tenantId: string; automationId: string } | null> {
  const r = await relayPool.query(
    "SELECT tenant_id, automation_id FROM webhook_routes WHERE token = $1",
    [token],
  );
  if (!r.rowCount) return null;
  return { tenantId: r.rows[0].tenant_id as string, automationId: r.rows[0].automation_id as string };
}

/** Attach the webhook token to a row: mint-or-read for a webhook trigger, no-op otherwise. */
async function attachWebhookToken(tenantId: string, row: AutomationRow, ensure = false): Promise<AutomationRow> {
  if (row.trigger !== "webhook") return row;
  row.webhookToken = ensure
    ? await ensureWebhookRoute(tenantId, row.id)
    : await getWebhookToken(tenantId, row.id);
  return row;
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export async function listAutomations(tenantId: string): Promise<AutomationRow[]> {
  const rows = await withTenant(tenantId, async (c) => {
    const r = await c.query(`SELECT ${COLS} FROM automations ORDER BY created_at DESC`);
    return r.rows.map(mapRow);
  });
  // Batch-attach webhook tokens (single relay query for the whole tenant, no N+1).
  if (rows.some((x) => x.trigger === "webhook")) {
    const tr = await relayPool.query(
      "SELECT automation_id, token FROM webhook_routes WHERE tenant_id = $1",
      [tenantId],
    );
    const m = new Map(tr.rows.map((x: { automation_id: string; token: string }) => [x.automation_id, x.token]));
    for (const x of rows) if (x.trigger === "webhook") x.webhookToken = m.get(x.id) ?? null;
  }
  return rows;
}

export async function getAutomation(tenantId: string, id: string): Promise<AutomationRow | null> {
  const row = await withTenant(tenantId, async (c) => {
    const r = await c.query(`SELECT ${COLS} FROM automations WHERE id = $1`, [id]);
    return r.rowCount ? mapRow(r.rows[0]) : null;
  });
  return row ? attachWebhookToken(tenantId, row) : null;
}

export async function createAutomation(tenantId: string, input: AutomationInput): Promise<AutomationRow> {
  const row = await withTenant(tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO automations (tenant_id, name, enabled, trigger_event, trigger_config, conditions, actions, graph)
       VALUES (current_tenant(), $1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb)
       RETURNING ${COLS}`,
      [
        input.name,
        input.enabled ?? true,
        input.trigger,
        input.triggerConfig ? JSON.stringify(input.triggerConfig) : null,
        JSON.stringify(input.conditions ?? { match: "all", conditions: [] }),
        JSON.stringify(input.actions ?? []),
        input.graph ? JSON.stringify(input.graph) : null,
      ],
    );
    const created = mapRow(r.rows[0]);
    await snapshotVersion(c, created); // record v1's graph
    return created;
  });
  // A webhook automation gets a routing token minted on create.
  return attachWebhookToken(tenantId, row, true);
}

export async function updateAutomation(
  tenantId: string,
  id: string,
  patch: AutomationUpdateInput,
): Promise<AutomationRow | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (patch.name !== undefined) { sets.push(`name = $${i++}`); vals.push(patch.name); }
  if (patch.enabled !== undefined) { sets.push(`enabled = $${i++}`); vals.push(patch.enabled); }
  if (patch.trigger !== undefined) { sets.push(`trigger_event = $${i++}`); vals.push(patch.trigger); }
  if (patch.triggerConfig !== undefined) { sets.push(`trigger_config = $${i++}::jsonb`); vals.push(patch.triggerConfig ? JSON.stringify(patch.triggerConfig) : null); }
  if (patch.conditions !== undefined) { sets.push(`conditions = $${i++}::jsonb`); vals.push(JSON.stringify(patch.conditions)); }
  if (patch.actions !== undefined) { sets.push(`actions = $${i++}::jsonb`); vals.push(JSON.stringify(patch.actions)); }
  // A graph re-write bumps the version and snapshots the new graph — reproducible history, and a
  // mid-run edit lands as a new version rather than mutating the one a run is executing.
  const graphChanged = patch.graph !== undefined;
  if (graphChanged) { sets.push(`graph = $${i++}::jsonb`); vals.push(patch.graph ? JSON.stringify(patch.graph) : null); sets.push("version = version + 1"); }
  sets.push("updated_at = now()");
  const row = await withTenant(tenantId, async (c) => {
    const r = await c.query(
      `UPDATE automations SET ${sets.join(", ")} WHERE id = $${i} RETURNING ${COLS}`,
      [...vals, id],
    );
    if (!r.rowCount) return null;
    const updated = mapRow(r.rows[0]);
    if (graphChanged) await snapshotVersion(c, updated);
    return updated;
  });
  // If the (new or unchanged) trigger is webhook, mint-or-read its token; leaving a stale route
  // when the trigger changed away from webhook is harmless (see 0028 migration note).
  return row ? attachWebhookToken(tenantId, row, true) : null;
}

/** Fork-to-customize (the documented-but-missing `graduate` lever, STUDIO-SEEDED-FLOWS.md §3.4):
 *  deep-copy a MANAGED automation into a new hand-authored (managed_by=null), DISABLED draft and
 *  DISABLE the managed source so the two can't double-fire. The tenant then edits the copy freely
 *  on the canvas. Returns the new draft, or null when the id is gone / not managed.
 *
 *  Caveat: re-running the source Settings form re-projects (full-replace) the managed rows, which
 *  re-enables the source — a deliberate "go back to Settings" act. Documented in PLAN.md §4. */
export async function graduateAutomation(tenantId: string, id: string): Promise<AutomationRow | null> {
  return withTenant(tenantId, async (c) => {
    const src = await c.query(`SELECT ${COLS} FROM automations WHERE id = $1`, [id]);
    if (!src.rowCount) return null;
    const s = mapRow(src.rows[0]);
    if (!s.managedBy) return null; // only managed rows graduate (the route maps null → 400)
    const ins = await c.query(
      `INSERT INTO automations (tenant_id, name, enabled, trigger_event, trigger_config, conditions, actions, graph, managed_by)
       VALUES (current_tenant(), $1, false, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, NULL)
       RETURNING ${COLS}`,
      [
        `${s.name} (custom)`, s.trigger,
        s.triggerConfig ? JSON.stringify(s.triggerConfig) : null,
        JSON.stringify(s.conditions), JSON.stringify(s.actions),
        s.graph ? JSON.stringify(s.graph) : null,
      ],
    );
    const copy = mapRow(ins.rows[0]);
    await snapshotVersion(c, copy);
    await c.query("UPDATE automations SET enabled = false WHERE id = $1", [id]);
    return copy;
  });
}

export async function deleteAutomation(tenantId: string, id: string): Promise<boolean> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query("DELETE FROM automations WHERE id = $1", [id]);
    return (r.rowCount ?? 0) > 0;
  });
}

export async function listRuns(tenantId: string, automationId?: string, limit = 50): Promise<AutomationRunRow[]> {
  const cap = Math.min(Math.max(limit, 1), 200);
  return withTenant(tenantId, async (c) => {
    const r = automationId
      ? await c.query(
          `SELECT id, automation_id, trigger_event, status, ticket_id, actions_result, trace, error, created_at
             FROM automation_runs WHERE automation_id = $1 ORDER BY created_at DESC LIMIT $2`,
          [automationId, cap],
        )
      : await c.query(
          `SELECT id, automation_id, trigger_event, status, ticket_id, actions_result, trace, error, created_at
             FROM automation_runs ORDER BY created_at DESC LIMIT $1`,
          [cap],
        );
    return r.rows.map((row: Record<string, unknown>) => ({
      id: row.id as string,
      automationId: row.automation_id as string,
      trigger: row.trigger_event as string,
      status: row.status as string,
      ticketId: (row.ticket_id as string) ?? null,
      actionsResult: row.actions_result,
      trace: (row.trace as RunTraceEntry[]) ?? [],
      error: (row.error as string) ?? null,
      createdAt: iso(row.created_at) as string,
    }));
  });
}

/** Reserve a once-per-(tenant, key) slot in flow_dedupe. Returns true when newly reserved (the
 *  effect should run), false when it already existed (skip — at-most-once). Backs the `survey`
 *  action's "one survey per ticket" guard; generic so other at-most-once effects can reuse it. */
export async function reserveOnce(tenantId: string, key: string): Promise<boolean> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO flow_dedupe (tenant_id, dedupe_key) VALUES (current_tenant(), $1)
       ON CONFLICT (tenant_id, dedupe_key) DO NOTHING RETURNING dedupe_key`,
      [key],
    );
    return (r.rowCount ?? 0) > 0;
  });
}
