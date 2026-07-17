-- Wave 5 — AI moat sharpening (plan items 17/18/20).
-- 1. Confidence routing: autoreply_policy gains a per-channel mode map (replacing the
--    boolean allowed_channels), an optional model-confidence floor for auto-send, and
--    per-audience retrieval scoping (which knowledge surfaces public answers may cite).
-- 2. Agent-loop trace: agent_runs persists every autonomous-agent loop (interactive or
--    automation-node) so the ticket timeline can show exactly what the agent did and why.
-- 3. Slack answer-bot: per-connection opt-out flag for the @mention answer motion.

-- ── 1a. Per-channel confidence routing ───────────────────────────────────────
-- channel_modes: {"email":"auto","widget":"suggest_only","discord":"skip",...}. A channel
-- absent from the map inherits the global mode, EXCEPT under global mode='auto' where an
-- unlisted channel degrades to suggest_only — auto-SEND stays opt-in per channel, which
-- preserves the old allowed_channels semantics under the richer model.
ALTER TABLE autoreply_policy ADD COLUMN IF NOT EXISTS channel_modes jsonb NOT NULL DEFAULT '{}'::jsonb;
-- min_confidence: extra auto-send gate — a draft whose model confidence is below the floor
-- is held for review even when retrieval corroborates. NULL = gate off (rule-baseline
-- tenants report no calibrated confidence).
ALTER TABLE autoreply_policy ADD COLUMN IF NOT EXISTS min_confidence real;
-- source_scopes: {"public":["kb"],"agent":["kb","thread","document"]}. Which retrieval
-- surfaces each audience may draw from. Empty object = defaults (public: kb only; agent:
-- everything). 'public' covers the widget, docs embed, deflection and the public answer
-- API; 'agent' covers copilot suggestions and the autoreply gate.
ALTER TABLE autoreply_policy ADD COLUMN IF NOT EXISTS source_scopes jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Seed channel_modes from the legacy allowed_channels so tenants that explicitly enabled
-- auto-send on a channel keep it, then drop the legacy column (clean break — the map is
-- the one source of truth).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'autoreply_policy' AND column_name = 'allowed_channels') THEN
    UPDATE autoreply_policy
       SET channel_modes = COALESCE(
             (SELECT jsonb_object_agg(ch, 'auto') FROM unnest(allowed_channels) AS ch),
             '{}'::jsonb)
     WHERE channel_modes = '{}'::jsonb;
    ALTER TABLE autoreply_policy DROP COLUMN allowed_channels;
  END IF;
END $$;

-- The approval queue gains the confidence-floor hold reason.
ALTER TABLE autoreply_queue DROP CONSTRAINT IF EXISTS autoreply_queue_reason_ck;
ALTER TABLE autoreply_queue ADD CONSTRAINT autoreply_queue_reason_ck
  CHECK (reason IN ('suggest_only', 'weak_retrieval', 'low_confidence'));

-- ── 1b. Slack answer-bot flag ────────────────────────────────────────────────
-- true = @mentions of the bot get a grounded RAG answer in-thread (no ticket); plain
-- channel messages keep creating tickets either way.
ALTER TABLE slack_connections ADD COLUMN IF NOT EXISTS answer_bot boolean NOT NULL DEFAULT true;

-- ── 2. agent_runs — persisted agent-loop traces ──────────────────────────────
-- One row per runAgent() invocation. steps = the full loop trace (model decision, tool,
-- ok/detail per step); actions = the executed ActionResults summary. source 'manual' =
-- the ticket-page "run agent" button; 'automation' = an agent node inside a rule graph
-- (automation_id soft-links the rule — no FK, rules are deletable independently).
CREATE TABLE IF NOT EXISTS agent_runs (
  tenant_id     uuid NOT NULL,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  ticket_id     uuid,
  source        text NOT NULL DEFAULT 'manual',
  automation_id uuid,
  dry_run       boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'done',   -- done | error
  instructions  text NOT NULL DEFAULT '',
  model         text NOT NULL DEFAULT '',
  steps         jsonb NOT NULL DEFAULT '[]'::jsonb,
  actions       jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT agent_runs_source_ck CHECK (source IN ('manual', 'automation')),
  CONSTRAINT agent_runs_status_ck CHECK (status IN ('done', 'error')),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES tickets (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS agent_runs_ticket_idx ON agent_runs (tenant_id, ticket_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON agent_runs TO app_user;
GRANT SELECT ON agent_runs TO event_relay;

ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_runs_isolation ON agent_runs;
CREATE POLICY agent_runs_isolation ON agent_runs
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
