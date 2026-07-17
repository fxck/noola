-- NPS — Net Promoter Score, the relationship-level satisfaction sibling of CSAT. Score 0..10;
-- promoter = 9-10, passive = 7-8, detractor = 0-6; NPS = %promoters − %detractors. Submitted
-- through the public API (optionally tied to a ticket, but standalone relationship surveys are
-- allowed — ticket_id is nullable, so the composite FK is MATCH-SIMPLE-skipped when null).
CREATE TABLE IF NOT EXISTS nps_responses (
  tenant_id  uuid NOT NULL,
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  ticket_id  uuid,
  score      smallint NOT NULL CHECK (score BETWEEN 0 AND 10),
  comment    text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES tickets (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS nps_created_idx ON nps_responses (tenant_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON nps_responses TO app_user;
GRANT SELECT ON nps_responses TO event_relay;

ALTER TABLE nps_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE nps_responses FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nps_isolation ON nps_responses;
CREATE POLICY nps_isolation ON nps_responses
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
