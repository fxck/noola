-- Media that Discord previews for a link in a message (a GIF from /gif or Tenor, an image link) is
-- copied like an attachment. embed_url keeps the page it came from, for the "show as link" preference
-- and so the same preview is stored once per message or note.
ALTER TABLE message_attachments ADD COLUMN IF NOT EXISTS embed_url text;
CREATE UNIQUE INDEX IF NOT EXISTS message_attachments_embed_uq
  ON message_attachments (tenant_id, coalesce(message_id, note_id), embed_url)
  WHERE embed_url IS NOT NULL;
