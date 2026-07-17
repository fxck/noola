-- Slice 18 — Slack channel. A lightweight Slack channel modeled on Discord/email:
-- inbound Slack messages become tickets (via the shared ingestInbound seam,
-- channel 'slack'), and agent replies post back to the Slack channel.
--
-- slack_connections maps a Slack workspace (team_id) to the tenant that owns it,
-- and carries the xoxb- bot token used to reply via chat.postMessage.
--
-- UNLIKE discord_links / email_routes (which sit deliberately OUTSIDE RLS), this
-- table is TENANT-SCOPED under FORCE-RLS — it holds a per-tenant secret (bot_token),
-- so app_user CRUD must be isolated like webhooks. BUT the inbound team_id→tenant
-- lookup happens BEFORE any tenant context exists, so that resolution runs on the
-- event_relay (BYPASSRLS) role — same system-read path discord.ts/email.ts use for
-- their pre-tenant routing. event_relay gets SELECT so it can resolve across tenants.
CREATE TABLE IF NOT EXISTS slack_connections (
  tenant_id  uuid NOT NULL,
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  team_id    text NOT NULL,                 -- Slack workspace id
  bot_token  text NOT NULL DEFAULT '',      -- xoxb- token used for chat.postMessage
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
-- One tenant per workspace — inbound resolution keys on team_id globally.
CREATE UNIQUE INDEX IF NOT EXISTS slack_connections_team_uq ON slack_connections (team_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON slack_connections TO app_user;
-- event_relay (BYPASSRLS) resolves team_id→tenant BEFORE any tenant context exists.
GRANT SELECT ON slack_connections TO event_relay;

ALTER TABLE slack_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE slack_connections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS slack_connections_isolation ON slack_connections;
CREATE POLICY slack_connections_isolation ON slack_connections
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
