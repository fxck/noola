-- Internal notes / side conversations — agent-only annotations on a ticket. Kept in
-- a SEPARATE table from `messages` precisely because messages flow OUTBOUND to the
-- channel (Discord/email/Slack) on agent reply, whereas notes must NEVER be dispatched
-- — they're internal. The UI interleaves them into the thread by created_at. Composite
-- FK (tenant_id, ticket_id) is the same cross-tenant-proof pattern as messages.
CREATE TABLE IF NOT EXISTS ticket_notes (
  tenant_id   uuid NOT NULL,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  ticket_id   uuid NOT NULL,
  author_id   uuid,
  author_name text,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES tickets (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ticket_notes_ticket_idx ON ticket_notes (tenant_id, ticket_id, created_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON ticket_notes TO app_user;
GRANT SELECT ON ticket_notes TO event_relay;

ALTER TABLE ticket_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_notes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ticket_notes_isolation ON ticket_notes;
CREATE POLICY ticket_notes_isolation ON ticket_notes
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
