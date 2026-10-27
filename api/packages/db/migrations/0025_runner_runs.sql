-- 0025_runner_runs.sql — Agent Studio runner: the run-tracking table. One row per run job
-- enqueued to the `runner` docker execution service via the transactional outbox on subject
-- `jobs.run`. Tenant-scoped under FORCE RLS, following the 0024_automations idiom exactly
-- (composite PK, app_user CRUD grant, event_relay SELECT, `<table>_isolation` policy on
-- current_tenant()). Slice A: the api creates rows (status 'queued') + enqueues; the runner
-- skeleton consumes + echoes. Slice B: the worker records lifecycle (started_at / result /
-- finished_at). Idempotent (IF NOT EXISTS / DROP POLICY IF EXISTS) — reruns every deploy.
CREATE TABLE IF NOT EXISTS runner_runs (
  tenant_id   uuid NOT NULL,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  status      text NOT NULL DEFAULT 'queued',    -- 'queued' | 'running' | 'succeeded' | 'failed'
  kind        text NOT NULL DEFAULT 'automation', -- what enqueued it: 'automation' | 'tool' | 'manual'
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb, -- the job input (e.g. {cmd})
  result      text,                               -- run output (set by the worker, slice B)
  error       text,                               -- failure detail (set by the worker, slice B)
  created_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,                        -- worker picked it up (slice B)
  finished_at timestamptz,                        -- run completed (slice B)
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS runner_runs_recent_idx ON runner_runs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS runner_runs_status_idx ON runner_runs (tenant_id, status, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON runner_runs TO app_user;
GRANT SELECT ON runner_runs TO event_relay;

ALTER TABLE runner_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE runner_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS runner_runs_isolation ON runner_runs;
CREATE POLICY runner_runs_isolation ON runner_runs
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
