-- Slice 11 — draft_traces. One row per drafted reply (live or eval): the query, the
-- retrieved sources + fused scores, the draft, model/tokens/latency, the gate
-- decision, and the eventual human outcome. The durable trace store AND the eval
-- baseline (Opik's pattern, self-hosted). FORCE-RLS like every tenant table.
--
-- ticket_id is a SOFT reference (no FK): eval rows have no ticket, and the trace store
-- is an append-only audit/eval log meant to outlive the tickets it references — a
-- composite (tenant_id, ticket_id) FK with ON DELETE SET NULL can't null one column
-- without violating tenant_id NOT NULL, and CASCADE would erase eval-relevant history.

CREATE TABLE IF NOT EXISTS draft_traces (
  tenant_id     uuid NOT NULL,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),   -- also the OTel trace id
  ticket_id     uuid,                                      -- soft ref; null for eval replays
  message_id    uuid,                                      -- triggering customer message, when live
  query         text NOT NULL,
  sources       jsonb NOT NULL DEFAULT '[]',               -- [{kind,id,title,score,rank}] fused RRF results
  top_score     real,
  agreement     int,                                       -- distinct source kinds cited (0..3)
  draft         text NOT NULL DEFAULT '',
  model         text NOT NULL,                             -- model driver name
  embed_model   text,
  confidence    real,
  tokens_in     int,
  tokens_out    int,
  latency_ms    int,
  gate_outcome  text,                                      -- assist | auto_sent | suppressed (slice 10)
  gate_reason   text,
  risk_tags     text[] NOT NULL DEFAULT '{}',
  outcome       text,                                      -- human verdict: edited | sent_as_is | discarded | thumbs_up | thumbs_down
  outcome_at    timestamptz,
  source        text NOT NULL DEFAULT 'live',              -- live | eval
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS draft_traces_tenant_created_idx ON draft_traces (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS draft_traces_ticket_idx ON draft_traces (tenant_id, ticket_id);
CREATE INDEX IF NOT EXISTS draft_traces_outcome_idx ON draft_traces (tenant_id, outcome) WHERE outcome IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON draft_traces TO app_user;
GRANT SELECT ON draft_traces TO event_relay;

ALTER TABLE draft_traces ENABLE ROW LEVEL SECURITY;
ALTER TABLE draft_traces FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS draft_traces_isolation ON draft_traces;
CREATE POLICY draft_traces_isolation ON draft_traces
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
