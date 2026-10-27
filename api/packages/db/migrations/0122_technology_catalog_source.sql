-- Where a tenant's technology catalog comes from (0121 tables). 'zerops' = Noola itself imports it
-- daily from the public Zerops JSON schemas (zerops.yml bases + import.yml service types), and any
-- in-use version the schemas don't list reads as EOL. 'manual' = pushed via PUT /v1/public/technologies
-- (statuses exactly as sent; an unlisted version reads as unknown). One row per tenant.
CREATE TABLE IF NOT EXISTS technology_catalog (
  tenant_id    uuid NOT NULL DEFAULT current_tenant() REFERENCES tenants (id) ON DELETE CASCADE,
  source       text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'zerops')),
  synced_at    timestamptz,
  last_error   text,
  technologies integer NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON technology_catalog TO app_user;
-- event_relay (BYPASSRLS) discovers the tenants due for the daily Zerops import.
GRANT SELECT ON technology_catalog TO event_relay;
ALTER TABLE technology_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE technology_catalog FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS technology_catalog_isolation ON technology_catalog;
CREATE POLICY technology_catalog_isolation ON technology_catalog
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
