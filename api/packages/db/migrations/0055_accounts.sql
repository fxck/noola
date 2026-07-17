-- Wave 2: accounts & engagement. Promote "company" from a free-text field on a contact to a
-- first-class account record, and add feature-request tracking with ticket evidence.

-- ── Companies (account records) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS companies (
  tenant_id  uuid NOT NULL DEFAULT current_tenant() REFERENCES tenants (id) ON DELETE CASCADE,
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  domain     text NOT NULL DEFAULT '',
  plan       text NOT NULL DEFAULT '',
  attributes jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
-- One account per name per tenant (case-insensitive) — the backfill + upsert key.
CREATE UNIQUE INDEX IF NOT EXISTS companies_name_uq ON companies (tenant_id, lower(name));

GRANT SELECT, INSERT, UPDATE, DELETE ON companies TO app_user;
GRANT SELECT ON companies TO event_relay;
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS companies_isolation ON companies;
CREATE POLICY companies_isolation ON companies
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

-- Link contacts to a company record (keep the denormalized `company` text as a display fallback).
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_id uuid;
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_company_fk;
ALTER TABLE contacts ADD CONSTRAINT contacts_company_fk
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies (tenant_id, id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS contacts_company_id_idx ON contacts (tenant_id, company_id);

-- Backfill: one company per distinct non-empty contact.company (case-insensitive), then link.
INSERT INTO companies (tenant_id, name)
SELECT DISTINCT ON (tenant_id, lower(company)) tenant_id, company
  FROM contacts
 WHERE company <> ''
ON CONFLICT (tenant_id, lower(name)) DO NOTHING;

UPDATE contacts c
   SET company_id = co.id
  FROM companies co
 WHERE c.tenant_id = co.tenant_id
   AND c.company <> ''
   AND lower(c.company) = lower(co.name)
   AND c.company_id IS NULL;

-- ── Feature requests + ticket evidence ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS feature_requests (
  tenant_id   uuid NOT NULL DEFAULT current_tenant() REFERENCES tenants (id) ON DELETE CASCADE,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  description text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'open',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT feature_requests_status_ck CHECK (status IN ('open', 'planned', 'in_progress', 'shipped', 'declined'))
);
CREATE INDEX IF NOT EXISTS feature_requests_status_idx ON feature_requests (tenant_id, status, updated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON feature_requests TO app_user;
ALTER TABLE feature_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE feature_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS feature_requests_isolation ON feature_requests;
CREATE POLICY feature_requests_isolation ON feature_requests
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

-- Evidence: which tickets support a request (the "vote" count is the row count per request).
CREATE TABLE IF NOT EXISTS feature_request_tickets (
  tenant_id  uuid NOT NULL DEFAULT current_tenant() REFERENCES tenants (id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  ticket_id  uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, request_id, ticket_id),
  FOREIGN KEY (tenant_id, request_id) REFERENCES feature_requests (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, ticket_id)  REFERENCES tickets (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS frt_ticket_idx ON feature_request_tickets (tenant_id, ticket_id);

GRANT SELECT, INSERT, DELETE ON feature_request_tickets TO app_user;
ALTER TABLE feature_request_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE feature_request_tickets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS frt_isolation ON feature_request_tickets;
CREATE POLICY frt_isolation ON feature_request_tickets
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
