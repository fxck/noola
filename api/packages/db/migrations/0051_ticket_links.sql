-- Related / linked tickets — a non-destructive symmetric relation between two tickets (unlike
-- merge, which folds one into the other). Stored ONCE per pair in canonical order (a < b, uuid
-- comparison) so (a,b) and (b,a) can't both exist; queries for a ticket match `a = X OR b = X`.
-- Composite FKs carry tenant_id (no cross-tenant links) and cascade when either ticket is deleted.
CREATE TABLE IF NOT EXISTS ticket_links (
  tenant_id  uuid NOT NULL DEFAULT current_tenant() REFERENCES tenants (id) ON DELETE CASCADE,
  a          uuid NOT NULL,
  b          uuid NOT NULL,
  relation   text NOT NULL DEFAULT 'related',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, a, b),
  CONSTRAINT ticket_links_order_ck CHECK (a < b),
  FOREIGN KEY (tenant_id, a) REFERENCES tickets (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, b) REFERENCES tickets (tenant_id, id) ON DELETE CASCADE
);
-- Reverse-direction lookup (the PK already covers `a`).
CREATE INDEX IF NOT EXISTS ticket_links_b_idx ON ticket_links (tenant_id, b);

GRANT SELECT, INSERT, UPDATE, DELETE ON ticket_links TO app_user;
ALTER TABLE ticket_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ticket_links_isolation ON ticket_links;
CREATE POLICY ticket_links_isolation ON ticket_links
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
