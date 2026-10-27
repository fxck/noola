-- Custom fields — tenant-defined attributes on tickets (Noola/Intercom parity). Two tables:
-- the field DEFINITIONS (schema the tenant controls) and the per-ticket VALUES. Values are
-- stored as text and typed by the def (the app coerces/validates); this keeps the schema
-- flat and migration-free as tenants add fields. FORCE-RLS on both; the values table carries
-- composite FKs to BOTH the ticket and the def so a value can't outlive either.
CREATE TABLE IF NOT EXISTS custom_field_defs (
  tenant_id  uuid NOT NULL,
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  key        text NOT NULL,
  label      text NOT NULL,
  field_type text NOT NULL DEFAULT 'text' CHECK (field_type IN ('text','number','select','boolean','date')),
  options    text[] NOT NULL DEFAULT '{}',
  position   integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, key)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON custom_field_defs TO app_user;
GRANT SELECT ON custom_field_defs TO event_relay;
ALTER TABLE custom_field_defs ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_field_defs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS custom_field_defs_isolation ON custom_field_defs;
CREATE POLICY custom_field_defs_isolation ON custom_field_defs
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

CREATE TABLE IF NOT EXISTS ticket_custom_values (
  tenant_id  uuid NOT NULL,
  ticket_id  uuid NOT NULL,
  field_id   uuid NOT NULL,
  value      text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, ticket_id, field_id),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES tickets (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, field_id) REFERENCES custom_field_defs (tenant_id, id) ON DELETE CASCADE
);
GRANT SELECT, INSERT, UPDATE, DELETE ON ticket_custom_values TO app_user;
GRANT SELECT ON ticket_custom_values TO event_relay;
ALTER TABLE ticket_custom_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_custom_values FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ticket_custom_values_isolation ON ticket_custom_values;
CREATE POLICY ticket_custom_values_isolation ON ticket_custom_values
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
