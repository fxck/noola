-- Slack triage layer — in-Slack ticket management (message actions / emoji reactions / status card /
-- CSAT / account binding). Two small RLS tables.

-- The live Block Kit status card posted in a channel for a ticket (one per ticket), so we can edit it
-- in place (chat.update) as status/assignee/priority change.
CREATE TABLE IF NOT EXISTS slack_ticket_cards (
  tenant_id  uuid NOT NULL DEFAULT current_tenant(),
  ticket_id  uuid NOT NULL,
  channel    text NOT NULL,
  message_ts text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, ticket_id)
);
ALTER TABLE slack_ticket_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE slack_ticket_cards FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY slack_ticket_cards_iso ON slack_ticket_cards USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON slack_ticket_cards TO app_user;
GRANT SELECT ON slack_ticket_cards TO event_relay;

-- Account binding: a Slack channel maps to a customer company, so channel conversations roll up per
-- account (a ticket created in a bound channel inherits the company).
CREATE TABLE IF NOT EXISTS slack_channel_accounts (
  tenant_id  uuid NOT NULL DEFAULT current_tenant(),
  team_id    text NOT NULL,
  channel    text NOT NULL,
  company_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, team_id, channel),
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies (tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE slack_channel_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE slack_channel_accounts FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY slack_channel_accounts_iso ON slack_channel_accounts USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON slack_channel_accounts TO app_user;
GRANT SELECT ON slack_channel_accounts TO event_relay;
