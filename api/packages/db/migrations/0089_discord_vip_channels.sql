-- VIP private Discord channels (D5) — one channel per customer, Pylon/Slack-Connect shape.
--
-- thread_per_message: a top-level CUSTOMER message in the bound channel becomes a NEW ticket and
-- the bot immediately anchors a Discord thread on it — the thread IS the ticket's conversation
-- (existing thread=ticket machinery). Agents reply in-thread; top-level agent chatter never mints
-- tickets. Distinct from require_thread=false (legacy: whole channel = one rolling conversation).
ALTER TABLE discord_channel_bindings ADD COLUMN IF NOT EXISTS thread_per_message boolean NOT NULL DEFAULT false;

-- Account binding: a Discord channel maps to a customer company (Slack parity —
-- slack_channel_accounts, 0083), so a VIP channel's conversations roll up per account: a contact
-- minted/seen in the bound channel inherits the company when unattributed.
CREATE TABLE IF NOT EXISTS discord_channel_accounts (
  tenant_id  uuid NOT NULL DEFAULT current_tenant(),
  guild_id   text NOT NULL,
  channel_id text NOT NULL,
  company_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, guild_id, channel_id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies (tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE discord_channel_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE discord_channel_accounts FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY discord_channel_accounts_iso ON discord_channel_accounts USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON discord_channel_accounts TO app_user;
GRANT SELECT ON discord_channel_accounts TO event_relay;
