-- Slice 14 — Autoreply backlog jobs. Turning on auto (or suggest_only) mode should
-- not only react to the NEXT inbound message: it should sweep the EXISTING backlog of
-- tickets awaiting a reply (status='open' AND whose_turn='us') into a visible JOB QUEUE
-- and work through them live. One row per swept ticket; the partial unique index keeps
-- at most one ACTIVE (queued|processing) job per ticket, so a re-sweep is idempotent and
-- a stale processing job can be reclaimed. Same FORCE-RLS discipline as every tenant table.

CREATE TABLE IF NOT EXISTS autoreply_jobs (
  tenant_id   uuid NOT NULL,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  ticket_id   uuid NOT NULL,
  message_id  uuid,                              -- the resolved latest customer message (set at claim time)
  status      text NOT NULL DEFAULT 'queued',    -- queued|processing|sent|held|skipped|error
  reason      text NOT NULL DEFAULT '',
  result_message_id uuid,                         -- sent reply id, or queued-draft id when held
  meta        jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  finished_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES tickets(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT autoreply_jobs_status_ck CHECK (status IN ('queued','processing','sent','held','skipped','error'))
);
-- at most one ACTIVE job per ticket:
CREATE UNIQUE INDEX IF NOT EXISTS autoreply_jobs_active_uq ON autoreply_jobs (tenant_id, ticket_id) WHERE status IN ('queued','processing');
CREATE INDEX IF NOT EXISTS autoreply_jobs_recent_idx ON autoreply_jobs (tenant_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON autoreply_jobs TO app_user;
GRANT SELECT ON autoreply_jobs TO event_relay;

ALTER TABLE autoreply_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE autoreply_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS autoreply_jobs_isolation ON autoreply_jobs;
CREATE POLICY autoreply_jobs_isolation ON autoreply_jobs
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
