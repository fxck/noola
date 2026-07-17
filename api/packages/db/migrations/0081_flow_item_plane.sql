-- 0081 — Studio→Studio fold: flow versioning + richer container run output.
-- Idempotent (guards), FORCE RLS, tenant isolation on current_tenant(), app_user CRUD +
-- event_relay SELECT — matching the existing migration conventions.

-- Flow versioning: pin a run to the graph it ran (reliability §9).
ALTER TABLE automations ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS automation_versions (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  automation_id uuid NOT NULL,
  version       integer NOT NULL,
  graph         jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, automation_id, version)
);
ALTER TABLE automation_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_versions FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY automation_versions_isolation ON automation_versions
    USING (tenant_id = current_tenant());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, DELETE ON automation_versions TO app_user;
GRANT SELECT ON automation_versions TO event_relay;

-- Structured container output for flow runs: produced items (for splicing) + per-node trace.
ALTER TABLE runner_runs ADD COLUMN IF NOT EXISTS result_json jsonb;
ALTER TABLE runner_runs ADD COLUMN IF NOT EXISTS node_events jsonb;
