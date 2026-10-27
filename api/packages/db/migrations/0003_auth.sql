-- Slice 04 — auth. Password credentials on users. Superuser, idempotent.
-- Login must resolve email → user (and their tenant) BEFORE any tenant context
-- exists, so that lookup runs as event_relay (BYPASSRLS), like the discord_links
-- resolve. Grant it SELECT on users.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
GRANT SELECT ON users TO event_relay;
