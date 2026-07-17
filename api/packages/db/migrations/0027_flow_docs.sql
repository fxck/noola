-- 0027_flow_docs.sql — collaborative-canvas persistence (Lane 4b, Agent Studio).
-- One row per automation holds the encoded Yjs CRDT document — the source of truth for
-- reconnecting collaborators, loaded by the edge's FlowRoom before the first client syncs.
-- The queryable graph projection stays in automations.graph (0026), written alongside by the
-- edge on every debounced save, so the automations engine runs exactly what the canvas shows.
-- FORCE RLS, same idiom as automations (0024). Idempotent — reruns every deploy.
CREATE TABLE IF NOT EXISTS flow_docs (
  tenant_id     uuid NOT NULL,
  automation_id uuid NOT NULL,
  doc           bytea NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, automation_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON flow_docs TO app_user;

ALTER TABLE flow_docs ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_docs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS flow_docs_isolation ON flow_docs;
CREATE POLICY flow_docs_isolation ON flow_docs
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
