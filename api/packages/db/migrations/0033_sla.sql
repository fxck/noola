-- SLA policy (first cut) — one policy per tenant: first-response + resolution targets in
-- minutes. Per-ticket due/breach state is computed in the app from ticket timestamps
-- (created_at, first agent reply, closed_at); a business-hours-aware calendar is the
-- documented later upgrade. Same FORCE-RLS isolation as the other tenant tables.
CREATE TABLE IF NOT EXISTS sla_policies (
  tenant_id           uuid PRIMARY KEY,
  first_response_mins integer NOT NULL DEFAULT 60,
  resolution_mins     integer NOT NULL DEFAULT 1440,
  enabled             boolean NOT NULL DEFAULT false,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON sla_policies TO app_user;
GRANT SELECT ON sla_policies TO event_relay;
ALTER TABLE sla_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE sla_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sla_policies_isolation ON sla_policies;
CREATE POLICY sla_policies_isolation ON sla_policies
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
