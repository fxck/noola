-- Message attachments — files an agent attaches to a reply (and, later, inbound files). Kept in
-- their own table (not messages.meta) so a file is a first-class, servable, tenant-scoped row with a
-- storage key. Lifecycle: uploaded first (message_id NULL, "pending"), then CLAIMED onto the message
-- when the reply is sent. Composite FKs carry tenant_id so an attachment can never point at another
-- tenant's ticket/message — the same cross-tenant-proof pattern as messages/notes.
CREATE TABLE IF NOT EXISTS message_attachments (
  tenant_id    uuid NOT NULL,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  ticket_id    uuid NOT NULL,
  message_id   uuid,               -- NULL until the composed reply is sent + claims it
  uploaded_by  uuid,               -- the agent who uploaded (users.id), best-effort
  filename     text NOT NULL,
  content_type text NOT NULL,
  size_bytes   integer NOT NULL,
  storage_key  text NOT NULL,      -- object-storage key (attachments/<tenant>/<uuid>-<name>)
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, ticket_id)  REFERENCES tickets  (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, message_id) REFERENCES messages (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS message_attachments_message_idx ON message_attachments (tenant_id, message_id);
CREATE INDEX IF NOT EXISTS message_attachments_ticket_idx  ON message_attachments (tenant_id, ticket_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON message_attachments TO app_user;

ALTER TABLE message_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_attachments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS message_attachments_isolation ON message_attachments;
CREATE POLICY message_attachments_isolation ON message_attachments
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
