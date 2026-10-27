-- Messages historically recorded only author_type ('customer'|'agent') — never WHICH
-- agent. The inbox thread needs real author identity (multi-agent teams), so stamp the
-- sending user's id on agent messages. Old rows stay null (render falls back to "Agent");
-- no backfill by design.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS author_id uuid;
