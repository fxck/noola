-- Per-agent read state — one row per (ticket, agent) recording when that agent last read the
-- thread. A ticket reads "unread" for an agent when it carries a customer message newer than their
-- last_read_at (or they've never opened it). Drives the inbox unread dot; per-agent, so one agent
-- reading a ticket never clears it for another.
CREATE TABLE IF NOT EXISTS ticket_reads (
  tenant_id    uuid NOT NULL DEFAULT current_tenant() REFERENCES tenants (id) ON DELETE CASCADE,
  ticket_id    uuid NOT NULL,
  user_id      uuid NOT NULL,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, ticket_id, user_id),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES tickets (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ticket_reads_user_idx ON ticket_reads (tenant_id, user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON ticket_reads TO app_user;
ALTER TABLE ticket_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_reads FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ticket_reads_isolation ON ticket_reads;
CREATE POLICY ticket_reads_isolation ON ticket_reads
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
