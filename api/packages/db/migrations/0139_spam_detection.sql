-- Spam detection: who hid a ticket ('agent' | 'ai'), what kind it is ('spam' | 'outreach') and why.
-- Outreach is an unsolicited pitch that sits in the Spam folder but never counts towards a block.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS spam_source text;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS spam_kind text;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS spam_reason text;
-- spam_check: the spam check's verdict on the email that opened the ticket ('legit' | 'spam' | 'outreach' | 'failed').
-- spam_restored_at: when someone last marked the ticket as not spam. Both feed the spam analytics.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS spam_check text;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS spam_restored_at timestamptz;

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

-- A widget block holds the visitor's user id (contacts.external_id), which every conversation of theirs carries.
-- Blocks that hold a widget conversation id move to that conversation's user. Blocks of anonymous visitors stay as they are.
-- A handle that is already some contact's user id or e-mail is skipped, so a re-run never moves a block.
INSERT INTO blocked_senders (tenant_id, channel_type, scope, handle, reason, created_by, created_at)
SELECT DISTINCT ON (b.tenant_id, lower(c.external_id))
       b.tenant_id, 'widget', 'address', lower(c.external_id), b.reason, b.created_by, b.created_at
  FROM blocked_senders b
  JOIN tickets t ON t.tenant_id = b.tenant_id AND t.channel_type = 'widget' AND lower(t.external_channel_id) = b.handle
  JOIN contacts c ON c.tenant_id = t.tenant_id AND c.id = t.contact_id
 WHERE b.channel_type = 'widget' AND c.external_id IS NOT NULL AND c.external_id <> ''
   AND NOT EXISTS (SELECT 1 FROM contacts u WHERE u.tenant_id = b.tenant_id AND (lower(u.external_id) = b.handle OR lower(u.email) = b.handle))
 ORDER BY b.tenant_id, lower(c.external_id), b.created_at
ON CONFLICT (tenant_id, channel_type, scope, lower(handle)) DO NOTHING;

DELETE FROM blocked_senders b
 USING tickets t, contacts c
 WHERE b.channel_type = 'widget'
   AND t.tenant_id = b.tenant_id AND t.channel_type = 'widget' AND lower(t.external_channel_id) = b.handle
   AND c.tenant_id = t.tenant_id AND c.id = t.contact_id AND c.external_id IS NOT NULL AND c.external_id <> ''
   AND NOT EXISTS (SELECT 1 FROM contacts u WHERE u.tenant_id = b.tenant_id AND (lower(u.external_id) = b.handle OR lower(u.email) = b.handle));

-- AI traces also record each spam check ('spam_check'), next to the drafted replies ('draft').
ALTER TABLE draft_traces ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'draft';
