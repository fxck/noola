-- CSAT — customer-satisfaction responses, one row per submission, tied to a ticket.
-- Submitted by the end customer through the public API / messenger widget after a ticket
-- resolves (rating 1..5 + optional comment). Aggregated for the analytics dashboard and
-- shown on the ticket detail. Same composite-FK + FORCE-RLS isolation as messages/notes.
CREATE TABLE IF NOT EXISTS csat_responses (
  tenant_id  uuid NOT NULL,
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  ticket_id  uuid NOT NULL,
  rating     smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment    text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES tickets (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS csat_ticket_idx ON csat_responses (tenant_id, ticket_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON csat_responses TO app_user;
GRANT SELECT ON csat_responses TO event_relay;

ALTER TABLE csat_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE csat_responses FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS csat_isolation ON csat_responses;
CREATE POLICY csat_isolation ON csat_responses
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
