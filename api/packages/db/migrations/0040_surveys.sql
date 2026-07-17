-- Auto satisfaction surveys — per-tenant toggles for auto-delivering CSAT / NPS prompts when a
-- ticket resolves. The toggles are projected into a managed `ticket.closed → survey` automation
-- the engine dispatches (dogfood L2); once-per-ticket dedupe lives in flow_dedupe (0043). Same
-- FORCE-RLS isolation as the other tenant tables.
CREATE TABLE IF NOT EXISTS survey_settings (
  tenant_id    uuid PRIMARY KEY,
  csat_enabled boolean NOT NULL DEFAULT false,
  nps_enabled  boolean NOT NULL DEFAULT false,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON survey_settings TO app_user;
GRANT SELECT ON survey_settings TO event_relay;
ALTER TABLE survey_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE survey_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS survey_settings_isolation ON survey_settings;
CREATE POLICY survey_settings_isolation ON survey_settings
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
