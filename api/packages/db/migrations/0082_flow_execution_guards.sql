-- 0082_flow_execution_guards — Studio/Studio Phase 5 (multitenancy hardening).
-- Per-tenant egress policy for the item-flow http/browser nodes, and rolling per-day usage counters
-- for quotas. Both RLS-scoped (FORCE) on current_tenant(); app_user does CRUD, event_relay reads.
-- All idempotent (IF NOT EXISTS + DO-block policy guard), matching 0076–0081.

CREATE TABLE IF NOT EXISTS flow_egress_rules (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  pattern    text NOT NULL,                    -- host glob, e.g. api.stripe.com or *.acme.com
  mode       text NOT NULL DEFAULT 'allow',    -- 'allow' | 'deny'
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
ALTER TABLE flow_egress_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_egress_rules FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY flow_egress_rules_isolation ON flow_egress_rules
    USING (tenant_id = current_tenant());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON flow_egress_rules TO app_user;
GRANT SELECT ON flow_egress_rules TO event_relay;

-- Rolling per-day usage for quotas (http calls + container run count/ms).
CREATE TABLE IF NOT EXISTS flow_usage (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day       date NOT NULL DEFAULT current_date,
  kind      text NOT NULL,                     -- 'http' | 'run' | 'browser' | 'code'
  count     integer NOT NULL DEFAULT 0,
  ms        bigint  NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day, kind)
);
ALTER TABLE flow_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_usage FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY flow_usage_isolation ON flow_usage
    USING (tenant_id = current_tenant());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE ON flow_usage TO app_user;
GRANT SELECT ON flow_usage TO event_relay;
