-- E: cross-channel read receipts. Per-message "seen" timestamp — set when the customer views the
-- conversation in the widget (read watermark on /public/conversation) or opens an agent email (a
-- tracking-pixel hit on /public/seen/:id). NULL = not yet seen. The thread renders "Seen · <time>"
-- on the latest agent message that carries it. Channels without a reliable read signal (Discord,
-- Slack, …) simply never stamp it.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS seen_at timestamptz;

-- F: per-channel Discord close-action config. When a Noola-side close acts on a bound forum's post:
--   close_tag     — the forum tag NAME to apply as "resolved" (NULL = auto-detect a Solved/Resolved
--                   /Closed-style tag from the forum's own tags).
--   close_archive — archive (close) the post on resolve. Default on.
--   close_lock    — also lock the post (no further replies). Default off.
ALTER TABLE discord_channel_bindings ADD COLUMN IF NOT EXISTS close_tag text;
ALTER TABLE discord_channel_bindings ADD COLUMN IF NOT EXISTS close_archive boolean NOT NULL DEFAULT true;
ALTER TABLE discord_channel_bindings ADD COLUMN IF NOT EXISTS close_lock boolean NOT NULL DEFAULT false;
