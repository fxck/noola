-- 0125_discord_gateway_heartbeat.sql
-- When each bot's gateway was last seen connected on the gateway-event leader. A new leader, or a leader whose
-- session was re-established, backfills the Discord messages created since then. Idempotent (re-runnable).
CREATE TABLE IF NOT EXISTS discord_gateway_heartbeat (
  bot_id  text PRIMARY KEY,
  seen_at timestamptz NOT NULL
);

GRANT SELECT, INSERT, UPDATE ON discord_gateway_heartbeat TO event_relay;
