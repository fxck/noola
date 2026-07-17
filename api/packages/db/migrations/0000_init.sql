-- Noola slice-1 foundation — tenant registry + tickets/messages/users + outbox,
-- FORCE ROW LEVEL SECURITY tenant isolation, least-privilege roles.
-- Executed as the DB superuser (CREATE ROLE + BYPASSRLS require it).
-- Idempotent: safe to re-run every deploy.

-- ---- Roles ---------------------------------------------------------------
-- app_user   : the request-path role. RLS-bound (FORCE RLS applies to it).
-- event_relay : the outbox drainer. BYPASSRLS so one worker can publish across
--               tenants. Passwords are (re)synced from env in migrate.ts.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'event_relay') THEN
    CREATE ROLE event_relay LOGIN BYPASSRLS;
  END IF;
END $$;

-- ---- Tenant context helper ----------------------------------------------
-- On a pooled/reused backend the reset GUC is '' (empty string), NOT NULL,
-- so a naive ::uuid cast throws `invalid input syntax`. nullif(...) is
-- load-bearing — empirically validated on Zerops managed PG18.
CREATE OR REPLACE FUNCTION current_tenant() RETURNS uuid
  LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

-- ---- Tables --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  tenant_id  uuid NOT NULL,
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  email      text NOT NULL,
  name       text NOT NULL,
  role       text NOT NULL DEFAULT 'agent',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS tickets (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  subject         text NOT NULL,
  status          text NOT NULL DEFAULT 'open',
  status_category text NOT NULL DEFAULT 'open',
  channel_type    text NOT NULL DEFAULT 'synthetic',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS messages (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  ticket_id       uuid NOT NULL,
  author_type     text NOT NULL DEFAULT 'customer',
  body            text NOT NULL,
  idempotency_key text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  -- composite FK carries tenant_id so a message can never point at
  -- another tenant's ticket.
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES tickets (tenant_id, id) ON DELETE CASCADE
);

-- Idempotency: dedupe replays of the same inbound message per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS messages_tenant_idem_uq
  ON messages (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS outbox (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  event_type   text NOT NULL,
  subject      text NOT NULL,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;

-- ---- Grants (least privilege) -------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, users, tickets, messages, outbox TO app_user;
GRANT SELECT ON outbox TO event_relay;
GRANT UPDATE (published_at) ON outbox TO event_relay;

-- ---- Row Level Security --------------------------------------------------
-- FORCE so even the table owner is subject to policy: default-deny without
-- a tenant GUC. event_relay's BYPASSRLS role attribute steps around this.
ALTER TABLE tenants  ENABLE ROW LEVEL SECURITY; ALTER TABLE tenants  FORCE ROW LEVEL SECURITY;
ALTER TABLE users    ENABLE ROW LEVEL SECURITY; ALTER TABLE users    FORCE ROW LEVEL SECURITY;
ALTER TABLE tickets  ENABLE ROW LEVEL SECURITY; ALTER TABLE tickets  FORCE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY; ALTER TABLE messages FORCE ROW LEVEL SECURITY;
ALTER TABLE outbox   ENABLE ROW LEVEL SECURITY; ALTER TABLE outbox   FORCE ROW LEVEL SECURITY;

-- tenants: a tenant sees only its own row.
DROP POLICY IF EXISTS tenants_isolation ON tenants;
CREATE POLICY tenants_isolation ON tenants
  USING (id = current_tenant()) WITH CHECK (id = current_tenant());

-- tenant-scoped tables: row visible/writable only under the matching GUC.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','tickets','messages','outbox'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_isolation ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())',
      t, t);
  END LOOP;
END $$;
