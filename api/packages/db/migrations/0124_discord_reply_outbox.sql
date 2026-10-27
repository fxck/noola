-- 0124_discord_reply_outbox.sql
-- Agent and AI replies into Discord go through the relay outbox (kind 'reply'), so a Discord outage or an
-- IP ban retries them with backoff. Idempotent (re-runnable).
-- Every deploy re-runs this file, so it holds the full list of kinds: note_edit and note_delete keep a note's mirror copy in step.
ALTER TABLE discord_relay_outbox DROP CONSTRAINT IF EXISTS discord_relay_outbox_kind_check;
ALTER TABLE discord_relay_outbox
  ADD CONSTRAINT discord_relay_outbox_kind_check CHECK (kind IN ('message', 'note', 'react', 'reply', 'note_edit', 'note_delete'));
