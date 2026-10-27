-- Wave: contact ↔ many-companies. Promote the single-company link (contacts.company_id)
-- to a many-to-many junction so a contact can belong to several companies. The legacy
-- contacts.company_id + free-text contacts.company are KEPT and pinned to the *primary*
-- company, so every existing rollup (companies health CTE), directory filter, and
-- company-detail contact list keeps reading them unchanged. The junction is additive.

CREATE TABLE IF NOT EXISTS contact_companies (
  tenant_id  uuid NOT NULL DEFAULT current_tenant() REFERENCES tenants (id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  company_id uuid NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  role       text NOT NULL DEFAULT '',            -- optional label (e.g. "Billing", "Admin")
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, contact_id, company_id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts  (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies (tenant_id, id) ON DELETE CASCADE
);

-- At most one primary company per contact.
CREATE UNIQUE INDEX IF NOT EXISTS contact_companies_primary_uq
  ON contact_companies (tenant_id, contact_id) WHERE is_primary;
-- Reverse lookup: a company's contacts.
CREATE INDEX IF NOT EXISTS contact_companies_company_idx
  ON contact_companies (tenant_id, company_id);

-- Backfill: every contact that currently has a single company_id gets a primary junction row.
INSERT INTO contact_companies (tenant_id, contact_id, company_id, is_primary)
SELECT tenant_id, id, company_id, true
  FROM contacts
 WHERE company_id IS NOT NULL
ON CONFLICT (tenant_id, contact_id, company_id) DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON contact_companies TO app_user;
GRANT SELECT ON contact_companies TO event_relay;
ALTER TABLE contact_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_companies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contact_companies_isolation ON contact_companies;
CREATE POLICY contact_companies_isolation ON contact_companies
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
