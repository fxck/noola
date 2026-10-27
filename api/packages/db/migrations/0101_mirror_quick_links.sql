-- Per-binding quick-links rendered in the Discord mirror-post header (Backoffice, admin, etc.). Each
-- entry is {label, url}; the url may carry {ticket_id}/{email}/{external_id}/{company}/{name}
-- placeholders filled per ticket. Empty array = none (today's behavior). Relay-owned like the rest of
-- the mirror config.
ALTER TABLE discord_mirror_bindings ADD COLUMN IF NOT EXISTS quick_links jsonb NOT NULL DEFAULT '[]'::jsonb;
