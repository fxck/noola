-- Cached snapshot of each Discord guild's forums / text channels / roles, refreshed from the bot's
-- in-memory gateway cache (discord.js keeps these live via gateway events). Lets the Settings pages
-- (discord-mirror, discord-channels) render INSTANTLY from our own store and survive a bot/gateway
-- outage by showing the last-known lists — instead of blocking the request on a live Discord fetch,
-- which hung it into a 504.
--
-- RLS posture: guild-keyed and relay-accessed like discord_links / discord_mirror_bindings — GRANT to
-- event_relay, NO RLS. It is resolved by guild id (system-level Discord state, not tenant data), and
-- read/written only by the BYPASSRLS relay role; app_user never touches it.
CREATE TABLE IF NOT EXISTS discord_guild_cache (
  guild_id      text PRIMARY KEY REFERENCES discord_links (guild_id) ON DELETE CASCADE,
  forums        jsonb NOT NULL DEFAULT '[]'::jsonb,
  text_channels jsonb NOT NULL DEFAULT '[]'::jsonb,
  roles         jsonb NOT NULL DEFAULT '[]'::jsonb,
  synced_at     timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON discord_guild_cache TO event_relay;
-- NOTE: intentionally NO "ENABLE ROW LEVEL SECURITY" (see above), same as discord_links.
