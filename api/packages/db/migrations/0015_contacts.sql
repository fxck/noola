-- Slice 15 — Contacts directory. A tenant-scoped people/company directory with free-form
-- attributes, feeding the back-office sync (idempotent upsert on a caller's stable
-- external_id, else on email) and per-contact ticket history. Same FORCE-RLS discipline
-- as every other tenant table. Outbound webhooks on create/upsert are a later slice —
-- the module keeps that hook trivial to add.
--
-- Two idempotency keys: external_id (the caller's stable id) and a case-insensitive email.
-- Both are partial-unique so a NULL/blank never collides. company is indexed for the
-- exact-match directory filter.

CREATE TABLE IF NOT EXISTS contacts (
  tenant_id   uuid NOT NULL,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  external_id text,                    -- caller's stable id (for idempotent upsert)
  email       text,
  name        text NOT NULL DEFAULT '',
  company     text NOT NULL DEFAULT '',
  attributes  jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS contacts_external_uq ON contacts (tenant_id, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS contacts_email_uq ON contacts (tenant_id, lower(email)) WHERE email IS NOT NULL AND email <> '';
CREATE INDEX IF NOT EXISTS contacts_company_idx ON contacts (tenant_id, company);

GRANT SELECT, INSERT, UPDATE, DELETE ON contacts TO app_user;
GRANT SELECT ON contacts TO event_relay;

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contacts_isolation ON contacts;
CREATE POLICY contacts_isolation ON contacts
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
