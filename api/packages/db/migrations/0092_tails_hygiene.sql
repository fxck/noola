-- 0092 — tails & hygiene batch (2026-07-17):
--   1) runner_runs.replay_key — object-storage key of the run's recorded .webm replay (the
--      flow-runner container encodes its frame stream with ffmpeg and uploads on finalize).
--   2) channel_connections — per-tenant Telegram/WhatsApp credentials so channels connect
--      self-serve from Settings instead of operator env. Modeled on slack_connections:
--      FORCE-RLS tenant isolation for CRUD, event_relay SELECT for the pre-tenant inbound
--      resolution (WhatsApp phone_number_id → tenant; the Telegram poller iterating bots).
--      Secrets ride secret_enc through the crypto.ts seam (MODEL_KEY_SECRET), like integrations.
--   3) tenant_policies — one row per tenant for the enterprise governance knobs: data
--      retention window, agent-console IP allowlist, workspace 2FA requirement.
--   4) better-auth twoFactor plugin surface — "twoFactor" table + user."twoFactorEnabled",
--      verbatim plugin schema (dist/plugins/two-factor/schema.mjs), 0021 auth style
--      (quoted camelCase, text ids, auth_user grants).

-- ---- 1) run replay ----------------------------------------------------------
ALTER TABLE runner_runs ADD COLUMN IF NOT EXISTS replay_key text;

-- ---- 2) self-serve channel connections -------------------------------------
CREATE TABLE IF NOT EXISTS channel_connections (
  tenant_id  uuid NOT NULL,
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  channel    text NOT NULL,                        -- 'telegram' | 'whatsapp'
  label      text NOT NULL DEFAULT '',
  config     jsonb NOT NULL DEFAULT '{}'::jsonb,   -- non-secret shape (whatsapp: {"phoneId": ...})
  secret_enc text,                                 -- encrypted secret blob (crypto.ts)
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
-- WhatsApp inbound resolves globally by the Cloud API phone_number_id — one tenant per number.
CREATE UNIQUE INDEX IF NOT EXISTS channel_connections_wa_phone_uq
  ON channel_connections ((config->>'phoneId')) WHERE channel = 'whatsapp';

GRANT SELECT, INSERT, UPDATE, DELETE ON channel_connections TO app_user;
-- event_relay (BYPASSRLS) resolves inbound → tenant BEFORE any tenant context exists.
GRANT SELECT ON channel_connections TO event_relay;

ALTER TABLE channel_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_connections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS channel_connections_isolation ON channel_connections;
CREATE POLICY channel_connections_isolation ON channel_connections
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

-- ---- 3) tenant governance policies -----------------------------------------
CREATE TABLE IF NOT EXISTS tenant_policies (
  tenant_id      uuid PRIMARY KEY,
  retention_days integer,                              -- NULL = keep forever
  ip_allowlist   jsonb NOT NULL DEFAULT '[]'::jsonb,   -- IP/CIDR strings; empty = unrestricted
  require_2fa    boolean NOT NULL DEFAULT false,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_policies TO app_user;
-- The retention sweep discovers tenants-with-a-window across tenants (relayPool).
GRANT SELECT ON tenant_policies TO event_relay;

ALTER TABLE tenant_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_policies_isolation ON tenant_policies;
CREATE POLICY tenant_policies_isolation ON tenant_policies
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

-- ---- 4) better-auth twoFactor plugin ----------------------------------------
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "twoFactorEnabled" boolean DEFAULT false;

CREATE TABLE IF NOT EXISTS "twoFactor" (
  "id"                      text NOT NULL PRIMARY KEY,
  "secret"                  text NOT NULL,
  "backupCodes"             text NOT NULL,
  "userId"                  text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "verified"                boolean DEFAULT true,
  "failedVerificationCount" integer DEFAULT 0,
  "lockedUntil"             timestamptz
);
CREATE INDEX IF NOT EXISTS "twoFactor_userId_idx" ON "twoFactor" ("userId");
CREATE INDEX IF NOT EXISTS "twoFactor_secret_idx" ON "twoFactor" ("secret");

GRANT SELECT, INSERT, UPDATE, DELETE ON "twoFactor" TO auth_user;
