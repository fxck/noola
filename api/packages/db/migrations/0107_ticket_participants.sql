-- Ticket participants — named teammates added to a single conversation ("attendees"), distinct from
-- the one assignee and the team lane. A participant is dragged into a specific issue to collaborate;
-- they show in the context rail and (when their Discord id is mapped) get an @ping in the ops mirror.
-- Many participants per ticket; one row per (ticket, user); removing is a plain delete.

CREATE TABLE IF NOT EXISTS ticket_participants (
  tenant_id  uuid NOT NULL,
  ticket_id  uuid NOT NULL,
  user_id    uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, ticket_id, user_id),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES tickets (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id)   REFERENCES users   (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ticket_participants_user_idx ON ticket_participants (tenant_id, user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON ticket_participants TO app_user;
GRANT SELECT ON ticket_participants TO event_relay;
ALTER TABLE ticket_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_participants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ticket_participants_isolation ON ticket_participants;
CREATE POLICY ticket_participants_isolation ON ticket_participants
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
