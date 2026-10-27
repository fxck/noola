-- Macros / canned responses — reusable reply snippets a team inserts into the
-- composer. Tenant-scoped, FORCE RLS (same isolation as segments). `shortcut` is an
-- optional short slug the composer can offer for quick insertion.
CREATE TABLE IF NOT EXISTS macros (
  tenant_id  uuid NOT NULL,
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  body       text NOT NULL,
  shortcut   text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS macros_tenant_idx ON macros (tenant_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON macros TO app_user;
GRANT SELECT ON macros TO event_relay;

ALTER TABLE macros ENABLE ROW LEVEL SECURITY;
ALTER TABLE macros FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS macros_isolation ON macros;
CREATE POLICY macros_isolation ON macros
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
