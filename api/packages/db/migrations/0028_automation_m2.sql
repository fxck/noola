-- 0028_automation_m2.sql — Agent Studio Milestone 2: schedule + webhook triggers and a
-- per-node run trace. All additive + idempotent (the migrator reruns every file every deploy).

-- Schedule trigger config: {intervalMinutes?} for automations with trigger_event='schedule'.
-- Nullable — every other trigger ignores it, so existing rows are unaffected.
ALTER TABLE automations ADD COLUMN IF NOT EXISTS trigger_config jsonb;

-- Per-node execution trace of a run: [{nodeId,type,ok,detail}]. Complements actions_result by
-- recording WHICH graph node produced each result (nodeId is null for linear, non-graph rules)
-- so the builder can render a step-by-step trace.
ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS trace jsonb NOT NULL DEFAULT '[]'::jsonb;

-- webhook_routes: maps an unguessable webhook token → the tenant + automation it fires. Same
-- design as widget_keys / email_routes / discord_links: DELIBERATELY OUTSIDE RLS — POST
-- /hooks/:token resolves the tenant from the token BEFORE any tenant context exists, so it
-- cannot sit behind a tenant policy. Read/written only by event_relay (the BYPASSRLS cross-
-- tenant role); app_user never touches it. The unique index on (tenant_id, automation_id)
-- makes the "one route per webhook automation" upsert race-safe. No FK on automation_id
-- (automations' PK is composite (tenant_id,id)); an orphaned row after a delete is harmless —
-- it resolves to an automation that then has no enabled rules, so the fire no-ops.
CREATE TABLE IF NOT EXISTS webhook_routes (
  token         text PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  automation_id uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS webhook_routes_automation_idx ON webhook_routes (tenant_id, automation_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_routes TO event_relay;
-- NOTE: intentionally NO "ENABLE ROW LEVEL SECURITY" on webhook_routes (pre-tenant routing).
