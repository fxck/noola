-- Wave 4: conversational reach — multilingual support. Detect the language of a conversation and
-- (optionally) auto-translate between the customer's language and the workspace's. The detected
-- locale on the ticket also powers a language-volume breakdown. (Channel catalog / Telegram stub
-- need no schema — they read existing connection tables + a static catalog.)

-- Detected primary language of the conversation (ISO 639-1). Null until the first customer message
-- is classified; the ingest detector fills it once and leaves it (stable per conversation).
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS locale text;
CREATE INDEX IF NOT EXISTS tickets_locale_idx ON tickets (tenant_id, locale) WHERE locale IS NOT NULL;

-- Per-tenant translation settings: the workspace's own language + whether to auto-translate agent
-- replies into the customer's language on send. One row per tenant.
CREATE TABLE IF NOT EXISTS translation_settings (
  tenant_id       uuid PRIMARY KEY DEFAULT current_tenant() REFERENCES tenants (id) ON DELETE CASCADE,
  workspace_locale text    NOT NULL DEFAULT 'en',
  auto_translate   boolean NOT NULL DEFAULT false,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON translation_settings TO app_user;
ALTER TABLE translation_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE translation_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS translation_settings_isolation ON translation_settings;
CREATE POLICY translation_settings_isolation ON translation_settings
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
