-- Account sync from an external system of record (the public api-key surface, accounts:write):
-- companies (the system's clients) with spend, sync-owned memberships, projects and their services,
-- and a per-tenant technology catalog the services resolve against. Plus sync provenance on
-- contacts/companies so the directory can tell a real customer from a lead (a conference contact).

-- 1. Company name uniqueness only among companies WITHOUT an external_id. Synced companies are keyed
--    by external_id alone — two real clients may share a name ("Test", "Personal"). The index keeps
--    its name so 0055's `CREATE UNIQUE INDEX IF NOT EXISTS companies_name_uq` stays a no-op on re-run.
UPDATE companies SET external_id = NULL WHERE external_id = '';
DROP INDEX IF EXISTS companies_name_uq;
CREATE UNIQUE INDEX companies_name_uq ON companies (tenant_id, lower(name)) WHERE external_id IS NULL;

-- 2. Sync provenance. synced_at: last written by the sync API (null = never synced — a lead, a
--    widget visitor, a CSV row). sync_removed_at: the system of record deleted it; the row is kept
--    (history, conversations) and reads as a former customer until a sync revives it.
ALTER TABLE contacts  ADD COLUMN IF NOT EXISTS synced_at timestamptz;
ALTER TABLE contacts  ADD COLUMN IF NOT EXISTS sync_removed_at timestamptz;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS synced_at timestamptz;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS sync_removed_at timestamptz;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS avg_monthly_spend numeric(14,2);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS currency text;

-- 3. Membership provenance: a members sync replaces only 'sync' rows, never an agent's manual link.
ALTER TABLE contact_companies ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';

-- 4. Projects (a company's), keyed by the system's own id.
CREATE TABLE IF NOT EXISTS company_projects (
  tenant_id         uuid NOT NULL DEFAULT current_tenant() REFERENCES tenants (id) ON DELETE CASCADE,
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL,
  external_id       text NOT NULL,
  name              text NOT NULL DEFAULT '',
  status            text NOT NULL DEFAULT '',
  avg_monthly_spend numeric(14,2),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies (tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS company_projects_external_uq ON company_projects (tenant_id, external_id);
CREATE INDEX IF NOT EXISTS company_projects_company_idx ON company_projects (tenant_id, company_id);

-- 5. A project's services, replaced wholesale on every project snapshot. raw_type is exactly what the
--    system sent ("ubuntu/php-nginx@8.4+1.22", "postgresql:ha@16"); technology/version/os/mode are
--    parsed from it (technology resolved through the catalog's aliases).
CREATE TABLE IF NOT EXISTS project_services (
  tenant_id   uuid NOT NULL DEFAULT current_tenant() REFERENCES tenants (id) ON DELETE CASCADE,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL,
  external_id text,
  hostname    text NOT NULL DEFAULT '',
  raw_type    text NOT NULL,
  technology  text NOT NULL,
  version     text NOT NULL DEFAULT '',
  os          text NOT NULL DEFAULT '',
  mode        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES company_projects (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS project_services_project_idx ON project_services (tenant_id, project_id);
CREATE INDEX IF NOT EXISTS project_services_tech_idx ON project_services (tenant_id, technology, version);

-- 6. Technology catalog (pushed by the system of record, e.g. from the Zerops zerops.yaml/import.yaml
--    JSON schemas). aliases fold spelling variants onto one key (golang → go). A version's status
--    marks lifecycle: 'supported' | 'deprecated' | 'eol' (e.g. dropped from the schema).
CREATE TABLE IF NOT EXISTS technologies (
  tenant_id  uuid NOT NULL DEFAULT current_tenant() REFERENCES tenants (id) ON DELETE CASCADE,
  key        text NOT NULL,
  name       text NOT NULL DEFAULT '',
  category   text NOT NULL DEFAULT '',
  aliases    text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);
CREATE TABLE IF NOT EXISTS technology_versions (
  tenant_id  uuid NOT NULL DEFAULT current_tenant() REFERENCES tenants (id) ON DELETE CASCADE,
  technology text NOT NULL,
  version    text NOT NULL,
  status     text NOT NULL DEFAULT 'supported',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, technology, version),
  FOREIGN KEY (tenant_id, technology) REFERENCES technologies (tenant_id, key) ON DELETE CASCADE
);

GRANT SELECT, INSERT, UPDATE, DELETE ON company_projects, project_services, technologies, technology_versions TO app_user;
GRANT SELECT ON company_projects, project_services, technologies, technology_versions TO event_relay;

ALTER TABLE company_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_projects FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS company_projects_isolation ON company_projects;
CREATE POLICY company_projects_isolation ON company_projects
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE project_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_services FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS project_services_isolation ON project_services;
CREATE POLICY project_services_isolation ON project_services
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE technologies ENABLE ROW LEVEL SECURITY;
ALTER TABLE technologies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS technologies_isolation ON technologies;
CREATE POLICY technologies_isolation ON technologies
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE technology_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE technology_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS technology_versions_isolation ON technology_versions;
CREATE POLICY technology_versions_isolation ON technology_versions
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
