-- @mention / loop-in on internal notes: which member ids a note calls out. Resolved
-- server-side from @tokens in the note body against tenant users' names.
ALTER TABLE ticket_notes ADD COLUMN IF NOT EXISTS mentioned_ids uuid[] NOT NULL DEFAULT '{}';
