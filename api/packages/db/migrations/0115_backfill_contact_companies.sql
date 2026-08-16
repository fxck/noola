-- Backfill contact_companies from the denormalized scalar contacts.company.
--
-- The M2M junction (0111) is only ever populated going forward — by the back-office company editor and
-- (since the identify merge fix) by widget identify when it carries a company NAME. Contacts that
-- predate those paths kept ONLY the free-text scalar contacts.company, so the person-detail "companies"
-- list (which reads the junction) showed nothing for them even though a company name was on file.
--
-- For every contact that has a non-empty scalar company but NO junction membership yet: resolve-or-create
-- the company by name (case-insensitive, per tenant) and add a PRIMARY membership. Idempotent — re-running
-- touches nothing (NOT EXISTS + ON CONFLICT DO NOTHING). Only ever ADDS rows; never demotes or removes an
-- existing membership. Contacts with no scalar company (e.g. email-only contacts) are untouched — there is
-- no company to attach.

-- 1. Ensure a companies row exists for every distinct (tenant, scalar company name) still in use.
INSERT INTO companies (tenant_id, name)
SELECT DISTINCT c.tenant_id, c.company
  FROM contacts c
 WHERE c.company IS NOT NULL AND c.company <> ''
ON CONFLICT (tenant_id, lower(name)) DO NOTHING;

-- 2. Add a primary membership for each contact that has a scalar company but no junction row yet.
--    (is_primary = true is safe: the NOT EXISTS guarantees the contact has no membership, so the
--     one-primary-per-contact partial unique index is never violated.)
INSERT INTO contact_companies (tenant_id, contact_id, company_id, is_primary)
SELECT c.tenant_id, c.id, co.id, true
  FROM contacts c
  JOIN companies co ON co.tenant_id = c.tenant_id AND lower(co.name) = lower(c.company)
 WHERE c.company IS NOT NULL AND c.company <> ''
   AND NOT EXISTS (SELECT 1 FROM contact_companies cc WHERE cc.contact_id = c.id)
ON CONFLICT (tenant_id, contact_id, company_id) DO NOTHING;

-- 3. Pin the denormalized contacts.company_id to that primary where it's still null, so the legacy
--    single-company pointer agrees with the junction.
UPDATE contacts c
   SET company_id = co.id
  FROM companies co
 WHERE c.company_id IS NULL
   AND c.company IS NOT NULL AND c.company <> ''
   AND co.tenant_id = c.tenant_id AND lower(co.name) = lower(c.company);
