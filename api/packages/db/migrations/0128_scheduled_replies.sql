-- Delayed sending. An agent's reply or a 📤 promote from the Discord mirror waits here for the tenant's send delay.
-- It becomes a message only when it is sent, so a cancelled reply leaves nothing for the customer, webhooks or the mirror.
CREATE TABLE IF NOT EXISTS reply_settings (
  tenant_id          uuid PRIMARY KEY,
  send_delay_seconds integer NOT NULL DEFAULT 0 CHECK (send_delay_seconds BETWEEN 0 AND 600),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON reply_settings TO app_user;
ALTER TABLE reply_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE reply_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reply_settings_isolation ON reply_settings;
CREATE POLICY reply_settings_isolation ON reply_settings
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

CREATE TABLE IF NOT EXISTS scheduled_replies (
  tenant_id          uuid NOT NULL,
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  ticket_id          uuid NOT NULL,
  author_id          uuid,
  author_name        text,
  author_email       text,
  body               text NOT NULL,
  -- The rest of the reply request: attachmentIds, channel, cc.
  request            jsonb NOT NULL DEFAULT '{}'::jsonb,
  source             text NOT NULL DEFAULT 'composer' CHECK (source IN ('composer', 'discord_promote')),
  discord_message_id text,
  send_at            timestamptz NOT NULL,
  status             text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'sending', 'sent', 'cancelled', 'failed')),
  attempts           integer NOT NULL DEFAULT 0,
  -- The composer's double-submit token, so a retried send schedules one reply.
  client_message_id  text,
  message_id         uuid,
  last_error         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES tickets (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS scheduled_replies_due ON scheduled_replies (send_at) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS scheduled_replies_open ON scheduled_replies (tenant_id, ticket_id) WHERE status IN ('scheduled', 'sending');
CREATE UNIQUE INDEX IF NOT EXISTS scheduled_replies_client_uq
  ON scheduled_replies (tenant_id, client_message_id) WHERE client_message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS scheduled_replies_promote_uq
  ON scheduled_replies (tenant_id, discord_message_id) WHERE discord_message_id IS NOT NULL AND status IN ('scheduled', 'sending');

GRANT SELECT, INSERT, UPDATE, DELETE ON scheduled_replies TO app_user;
-- The send worker claims due rows across tenants.
GRANT SELECT, UPDATE ON scheduled_replies TO event_relay;
ALTER TABLE scheduled_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_replies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scheduled_replies_isolation ON scheduled_replies;
CREATE POLICY scheduled_replies_isolation ON scheduled_replies
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
