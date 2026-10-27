-- Ticket types — a tenant-defined taxonomy for tickets (Bug / Question / Billing / …),
-- distinct from priority (urgency) and tags (freeform). One optional type per ticket, chosen
-- from the tenant's set. Same FORCE-RLS isolation as the other tenant tables; the ticket's
-- type_id carries a composite FK so a type can't be referenced cross-tenant, and dropping a
-- type nulls it on its tickets (ON DELETE SET NULL) rather than blocking the delete.
CREATE TABLE IF NOT EXISTS ticket_types (
  tenant_id  uuid NOT NULL,
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  color      text NOT NULL DEFAULT 'slate',
  position   integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, name)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON ticket_types TO app_user;
GRANT SELECT ON ticket_types TO event_relay;
ALTER TABLE ticket_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_types FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ticket_types_isolation ON ticket_types;
CREATE POLICY ticket_types_isolation ON ticket_types
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS type_id uuid;
DO $$ BEGIN
  ALTER TABLE tickets ADD CONSTRAINT tickets_type_fk
    FOREIGN KEY (tenant_id, type_id) REFERENCES ticket_types (tenant_id, id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS tickets_type_idx ON tickets (tenant_id, type_id);
