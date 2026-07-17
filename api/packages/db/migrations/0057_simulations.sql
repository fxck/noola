-- Wave 3 completion: agent simulation / eval harness. Run the AI resolver over a sample of past
-- resolved tickets and record how it WOULD have answered — a report + per-ticket rows — so a team
-- can trust the AI before turning on auto-send. (Surge alerts, QA-by-agent, and QA↔CSAT need no
-- schema — they aggregate existing tickets / conversation_scores / csat_responses.)

CREATE TABLE IF NOT EXISTS simulation_runs (
  tenant_id      uuid NOT NULL DEFAULT current_tenant() REFERENCES tenants (id) ON DELETE CASCADE,
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  label          text NOT NULL DEFAULT '',
  sample_size    int  NOT NULL,
  avg_score      int,                       -- mean would-be QA score across items (null if empty)
  avg_confidence real,                      -- mean model confidence (null when the rule baseline)
  auto_send_rate real NOT NULL DEFAULT 0,   -- fraction that would have cleared the auto-send gate
  coverage       real NOT NULL DEFAULT 0,   -- fraction where retrieval found any grounding
  model          text NOT NULL DEFAULT 'rule',
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS simulation_runs_created_idx ON simulation_runs (tenant_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON simulation_runs TO app_user;
ALTER TABLE simulation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE simulation_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS simulation_runs_isolation ON simulation_runs;
CREATE POLICY simulation_runs_isolation ON simulation_runs
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

-- One row per simulated ticket in a run: the customer question, the AI's would-be answer + signals.
CREATE TABLE IF NOT EXISTS simulation_items (
  tenant_id      uuid NOT NULL DEFAULT current_tenant() REFERENCES tenants (id) ON DELETE CASCADE,
  run_id         uuid NOT NULL,
  ticket_id      uuid NOT NULL,
  subject        text NOT NULL DEFAULT '',
  question       text NOT NULL DEFAULT '',
  draft          text NOT NULL DEFAULT '',
  score          int  NOT NULL,
  confidence     real,
  agreement      int  NOT NULL DEFAULT 0,   -- distinct grounding source kinds cited
  citations      int  NOT NULL DEFAULT 0,
  would_auto_send boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, run_id, ticket_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES simulation_runs (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS simulation_items_run_idx ON simulation_items (tenant_id, run_id, score);

GRANT SELECT, INSERT, UPDATE, DELETE ON simulation_items TO app_user;
ALTER TABLE simulation_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE simulation_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS simulation_items_isolation ON simulation_items;
CREATE POLICY simulation_items_isolation ON simulation_items
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
