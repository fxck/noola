-- 0024_automations.sql — Agent Studio foundation: the unified integrations registry +
-- the automations (rules) engine. All three tables are tenant-scoped under FORCE RLS,
-- following the 0023_segments idiom exactly (composite PK, app_user CRUD grant, event_relay
-- SELECT, `<table>_isolation` policy on current_tenant()). Idempotent (IF NOT EXISTS /
-- DROP POLICY IF EXISTS) — the migrator reruns every file every deploy.

-- ── integrations ────────────────────────────────────────────────────────────
-- A tenant's outbound connectors: the notify/action targets an automation can send
-- through. One row per configured connector. `kind` selects the transport; `config` is the
-- per-kind non-secret settings (slack/discord: {}, email: {to}, http: {url, method?});
-- `secret_enc` is the AES-256-GCM blob (crypto.ts, key = MODEL_KEY_SECRET) for the
-- connector's credential (Slack/Discord incoming-webhook URL, http HMAC key) — encrypted at
-- rest, unlike the legacy plaintext slack_connections.bot_token / webhooks.secret. `status`
-- + `last_*` capture the most recent health test.
CREATE TABLE IF NOT EXISTS integrations (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  kind            text NOT NULL,                        -- 'slack' | 'discord' | 'email' | 'http'
  name            text NOT NULL,
  config          jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_enc      text,                                 -- encrypted credential (crypto.ts); null = none
  enabled         boolean NOT NULL DEFAULT true,
  status          text NOT NULL DEFAULT 'unconfigured', -- 'ok' | 'error' | 'unconfigured'
  last_error      text,
  last_checked_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS integrations_kind_idx ON integrations (tenant_id, kind, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON integrations TO app_user;
GRANT SELECT ON integrations TO event_relay;

ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS integrations_isolation ON integrations;
CREATE POLICY integrations_isolation ON integrations
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

-- ── automations ─────────────────────────────────────────────────────────────
-- A rule: WHEN <trigger_event> IF <conditions> THEN <actions>. `trigger_event` is one
-- domain event ('ticket.created' | 'message.received' | 'ticket.closed' | 'ticket.assigned');
-- `conditions` is a typed all/any AST ({match, conditions:[{field,op,value}]}); `actions` is
-- an ordered list of typed actions ([{type, ...params}]). Evaluated inline at the mutation
-- choke points (ingest.ts + the ticket routes), fire-and-forget, logged to automation_runs.
-- (Column is trigger_event, not `trigger` — TRIGGER is a reserved SQL keyword.)
CREATE TABLE IF NOT EXISTS automations (
  tenant_id     uuid NOT NULL,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  enabled       boolean NOT NULL DEFAULT true,
  trigger_event text NOT NULL,
  conditions    jsonb NOT NULL DEFAULT '{"match":"all","conditions":[]}'::jsonb,
  actions       jsonb NOT NULL DEFAULT '[]'::jsonb,
  run_count     integer NOT NULL DEFAULT 0,
  last_run_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS automations_trigger_idx ON automations (tenant_id, trigger_event) WHERE enabled;

GRANT SELECT, INSERT, UPDATE, DELETE ON automations TO app_user;
GRANT SELECT ON automations TO event_relay;

ALTER TABLE automations ENABLE ROW LEVEL SECURITY;
ALTER TABLE automations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS automations_isolation ON automations;
CREATE POLICY automations_isolation ON automations
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

-- ── automation_runs ─────────────────────────────────────────────────────────
-- One row per automation evaluation that MATCHED (or errored while acting) — the run log +
-- audit surface. `status` ∈ 'success' | 'partial' | 'error'. `actions_result` records each
-- action's outcome; `event` snapshots the triggering context for replay/debug. Non-matching
-- evaluations are silent (no row) so the log stays signal, not noise.
CREATE TABLE IF NOT EXISTS automation_runs (
  tenant_id      uuid NOT NULL,
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  automation_id  uuid NOT NULL,
  trigger_event  text NOT NULL,
  status         text NOT NULL,
  ticket_id      uuid,
  event          jsonb NOT NULL DEFAULT '{}'::jsonb,
  actions_result jsonb NOT NULL DEFAULT '[]'::jsonb,
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS automation_runs_by_automation_idx ON automation_runs (tenant_id, automation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS automation_runs_recent_idx ON automation_runs (tenant_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON automation_runs TO app_user;
GRANT SELECT ON automation_runs TO event_relay;

ALTER TABLE automation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS automation_runs_isolation ON automation_runs;
CREATE POLICY automation_runs_isolation ON automation_runs
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
