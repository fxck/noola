-- Slice 09 — BYO per-tenant model config. One row per tenant selects the provider
-- behind the AI drafts: 'managed' (the deterministic rule baseline / a future
-- hosted add-on) or a bring-your-own hosted model ('openai' | 'anthropic' |
-- 'custom' OpenAI-compatible endpoint). The API key is stored ENCRYPTED at rest
-- (AES-256-GCM, key derived from MODEL_KEY_SECRET — see apps/api/src/crypto.ts);
-- plaintext keys never touch the DB and the key is never returned to the client.
-- Same FORCE-RLS discipline as every tenant table; singleton PK on tenant_id.

CREATE TABLE IF NOT EXISTS model_config (
  tenant_id   uuid NOT NULL,
  provider    text NOT NULL DEFAULT 'managed',
  endpoint    text,
  model       text,
  key_cipher  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id),
  CONSTRAINT model_config_provider_ck
    CHECK (provider IN ('managed', 'openai', 'anthropic', 'custom'))
);

GRANT SELECT, INSERT, UPDATE, DELETE ON model_config TO app_user;

ALTER TABLE model_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_config FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS model_config_isolation ON model_config;
CREATE POLICY model_config_isolation ON model_config
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
