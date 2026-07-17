-- Slice 02 — Discord channel. Adds the guild→tenant routing map and a
-- reply-routing column on tickets. Executed as superuser, idempotent.

-- discord_links: maps a Discord guild (server) to the tenant that owns it.
-- DELIBERATELY OUTSIDE RLS. This table is read to RESOLVE the tenant, *before*
-- any tenant context exists — so it cannot sit behind a tenant policy (there is
-- no current_tenant() yet). It is system-level routing config, not tenant data.
-- Read/written only by event_relay (the BYPASSRLS cross-tenant role); app_user
-- never touches it. The FK to tenants is enforced by PG's internal RI path,
-- which bypasses the referenced table's RLS.
CREATE TABLE IF NOT EXISTS discord_links (
  guild_id   text PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON discord_links TO event_relay;
-- NOTE: intentionally NO "ENABLE ROW LEVEL SECURITY" on discord_links (see above).

-- tickets: where to post replies for an externally-originated ticket. For Discord
-- this is the channel id; one ticket per channel/thread. channel_type already
-- exists from 0000 (defaults 'synthetic').
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS external_channel_id text;
CREATE INDEX IF NOT EXISTS tickets_tenant_extchan_idx
  ON tickets (tenant_id, external_channel_id) WHERE external_channel_id IS NOT NULL;
