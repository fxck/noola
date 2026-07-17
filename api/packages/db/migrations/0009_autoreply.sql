-- Slice 10 — Autoreply (confidence-gated auto-send). Per-tenant policy (mode +
-- guardrail knobs) and an audit trail of every evaluated inbound customer message —
-- the latter is also the idempotency anchor for the gate. Auto-send is OFF by
-- default; a tenant opts in explicitly. Same FORCE-RLS discipline as every tenant table.

CREATE TABLE IF NOT EXISTS autoreply_policy (
  tenant_id            uuid PRIMARY KEY,
  mode                 text   NOT NULL DEFAULT 'off',        -- off | suggest_only | auto
  min_agreement        int    NOT NULL DEFAULT 2,            -- distinct source kinds required to auto-send
  min_top_score        real   NOT NULL DEFAULT 0,            -- secondary continuous gate (0 = ignore)
  allowed_channels     text[] NOT NULL DEFAULT '{synthetic,discord}',
  max_auto_per_thread  int    NOT NULL DEFAULT 3,            -- consecutive auto-sends before forcing a human
  max_auto_per_hour    int    NOT NULL DEFAULT 30,           -- per-tenant rate cap
  kill_switch          boolean NOT NULL DEFAULT false,       -- per-tenant panic off (env AUTOREPLY_KILL=1 = global)
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT autoreply_policy_mode_ck CHECK (mode IN ('off', 'suggest_only', 'auto'))
);

-- One row per evaluated inbound customer message. The UNIQUE (tenant_id, message_id)
-- index is the idempotency guard: a redelivery/replay conflicts and no-ops.
CREATE TABLE IF NOT EXISTS autoreply_decisions (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  message_id      uuid NOT NULL,                 -- the triggering inbound customer message
  ticket_id       uuid NOT NULL,
  outcome         text NOT NULL,                 -- assist | auto_sent | suppressed
  reason          text NOT NULL DEFAULT '',      -- e.g. 'guardrail:refund_dispute' | 'weak_retrieval' | 'thread_cap'
  agreement       int,
  top_score       real,
  confidence      real,
  risk_tags       text[] NOT NULL DEFAULT '{}',
  sent_message_id uuid,                           -- the auto-sent reply, when outcome='auto_sent'
  trace_id        uuid,                           -- soft link to draft_traces.id (slice 11)
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT autoreply_decisions_outcome_ck CHECK (outcome IN ('assist', 'auto_sent', 'suppressed')),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES tickets (tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS autoreply_decisions_msg_uq
  ON autoreply_decisions (tenant_id, message_id);
CREATE INDEX IF NOT EXISTS autoreply_decisions_rate_idx
  ON autoreply_decisions (tenant_id, created_at) WHERE outcome = 'auto_sent';

-- Label auto-sent replies in the transcript (and, later, on the edge / in the UI).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS auto boolean NOT NULL DEFAULT false;

GRANT SELECT, INSERT, UPDATE, DELETE ON autoreply_policy TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON autoreply_decisions TO app_user;
GRANT SELECT ON autoreply_policy TO event_relay;
GRANT SELECT ON autoreply_decisions TO event_relay;

ALTER TABLE autoreply_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE autoreply_policy FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS autoreply_policy_isolation ON autoreply_policy;
CREATE POLICY autoreply_policy_isolation ON autoreply_policy
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE autoreply_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE autoreply_decisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS autoreply_decisions_isolation ON autoreply_decisions;
CREATE POLICY autoreply_decisions_isolation ON autoreply_decisions
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
