-- Internal notes can carry attachments too — e.g. a screenshot posted by the team inside a Discord
-- mirror thread, which lands as an internal note on the ticket. Rather than a parallel table + a
-- second serve route, reuse message_attachments: a NOTE attachment is a row with note_id set and
-- message_id NULL (a MESSAGE attachment keeps message_id set, note_id NULL). Same owned-bytes model,
-- same authed serve path (keyed by id), same RLS + grants — nothing else changes.
ALTER TABLE message_attachments ADD COLUMN IF NOT EXISTS note_id uuid;
CREATE INDEX IF NOT EXISTS message_attachments_note_idx
  ON message_attachments (tenant_id, note_id) WHERE note_id IS NOT NULL;
