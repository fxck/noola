-- Internal notes stay in step with the Discord mirror: a note written in Noola can be edited, deleted or sent
-- to the customer, and the bot's copy in the mirror thread follows.

-- The bot's copy of a Noola note in its mirror thread. A long note takes several Discord messages, in order.
CREATE TABLE IF NOT EXISTS note_mirror_posts (
  discord_message_id text PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  ticket_id          uuid NOT NULL,
  note_id            uuid NOT NULL,
  thread_id          text NOT NULL,
  position           integer NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS note_mirror_posts_note_idx ON note_mirror_posts (tenant_id, note_id, position);
GRANT SELECT, INSERT, UPDATE, DELETE ON note_mirror_posts TO event_relay;

ALTER TABLE ticket_notes ADD COLUMN IF NOT EXISTS edited_at timestamptz;

-- One send per note at a time, so a double click or a second 📤 can't send it twice.
CREATE UNIQUE INDEX IF NOT EXISTS scheduled_replies_note_uq
  ON scheduled_replies (tenant_id, (request->>'noteId')) WHERE source = 'note' AND status IN ('scheduled', 'sending');
