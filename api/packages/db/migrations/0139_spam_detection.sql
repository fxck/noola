-- Spam detection: who hid a ticket ('agent' | 'ai'), what kind it is ('spam' | 'outreach') and why.
-- Outreach is an unsolicited pitch that sits in the Spam folder but never counts towards a block.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS spam_source text;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS spam_kind text;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS spam_reason text;

-- block_after: a sender is blocked once this many conversations from them are spam, 0 turns it off.
CREATE TABLE IF NOT EXISTS spam_settings (
  tenant_id   uuid PRIMARY KEY DEFAULT current_tenant() REFERENCES tenants (id) ON DELETE CASCADE,
  ai_enabled  boolean NOT NULL DEFAULT false,
  rules       text NOT NULL DEFAULT '',
  block_after integer NOT NULL DEFAULT 2,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- prompt: the workspace's own system prompt, null while it uses the built-in one.
ALTER TABLE spam_settings ADD COLUMN IF NOT EXISTS prompt text;

GRANT SELECT, INSERT, UPDATE, DELETE ON spam_settings TO app_user;
ALTER TABLE spam_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE spam_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS spam_settings_isolation ON spam_settings;
CREATE POLICY spam_settings_isolation ON spam_settings
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

-- AI traces also record each spam check ('spam_check'), next to the drafted replies ('draft').
ALTER TABLE draft_traces ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'draft';
