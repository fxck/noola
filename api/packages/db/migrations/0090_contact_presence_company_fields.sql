-- Contact presence (channel-agnostic "active now") + company custom-field values.
--
-- last_seen_at: bumped (throttled) by any widget touch — /public/ask, conversation polls,
-- identify/track. "Online" is DERIVED at read time (last_seen_at within a small window), so both
-- the WS and polling widget paths count and nothing needs a disconnect hook.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
CREATE INDEX IF NOT EXISTS contacts_last_seen_idx ON contacts (tenant_id, last_seen_at DESC);

-- Custom fields grow an entity scope: the same tenant-defined defs mechanism now covers companies
-- (audit: companies had only a free-form attributes bag and no editable schema). Existing rows are
-- ticket-scoped; company values land in their own table mirroring ticket_custom_values.
ALTER TABLE custom_field_defs ADD COLUMN IF NOT EXISTS entity text NOT NULL DEFAULT 'ticket';

CREATE TABLE IF NOT EXISTS company_custom_values (
  tenant_id  uuid NOT NULL DEFAULT current_tenant(),
  company_id uuid NOT NULL,
  field_id   uuid NOT NULL,
  value      text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, company_id, field_id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies (tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE company_custom_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_custom_values FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY company_custom_values_iso ON company_custom_values USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON company_custom_values TO app_user;
