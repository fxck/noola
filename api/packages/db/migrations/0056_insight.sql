-- Wave 3: insight & conversation intelligence.
--   1. tickets.topic     — a single primary topic per ticket (the Topics explorer groups on it)
--   2. conversation_scores — per-ticket QA scoring (resolution/tone/completeness → overall + band)
--   3. agent_persona     — per-tenant assistant voice fed into the draft/autoreply system prompt

-- ── Ticket topic (single primary topic; tags stay multi-label & separate) ─────
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS topic text;
CREATE INDEX IF NOT EXISTS tickets_topic_idx ON tickets (tenant_id, topic) WHERE topic IS NOT NULL;

-- Backfill a best-effort topic from the subject keywords so the explorer isn't empty on day one.
-- Only fills NULLs (idempotent); the ingest classifier owns everything going forward.
UPDATE tickets SET topic = CASE
    WHEN subject ~* '\y(invoice|billing|charged?|payment|subscription|price|receipt|refund)\y' THEN 'billing'
    WHEN subject ~* '\y(cancel|unsubscribe|terminate)\y'                                        THEN 'cancellation'
    WHEN subject ~* '\y(bug|error|broken|crash|not working|fails?|glitch|500|404)\y'            THEN 'bug'
    WHEN subject ~* '\y(login|log in|sign in|password|reset|locked out|2fa|access)\y'           THEN 'account'
    WHEN subject ~* '\y(integrat|webhook|api|zapier|slack|connect)\y'                           THEN 'integration'
    WHEN subject ~* '\y(how (do|can|to)|where do|tutorial|guide)\y'                             THEN 'how-to'
    WHEN subject ~* '\y(feature|would be (great|nice)|please add|suggestion)\y'                 THEN 'feature-request'
    WHEN subject ~* '\y(shipping|delivery|tracking|order|package)\y'                            THEN 'shipping'
    ELSE 'general'
  END
  WHERE topic IS NULL;

-- ── Conversation QA scores (one per ticket; a re-score upserts) ───────────────
CREATE TABLE IF NOT EXISTS conversation_scores (
  tenant_id    uuid NOT NULL DEFAULT current_tenant() REFERENCES tenants (id) ON DELETE CASCADE,
  ticket_id    uuid NOT NULL,
  overall      int  NOT NULL,
  resolution   int  NOT NULL,
  tone         int  NOT NULL,
  completeness int  NOT NULL,
  band         text NOT NULL,
  rationale    text NOT NULL DEFAULT '',
  model        text NOT NULL DEFAULT 'rule',
  scored_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, ticket_id),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES tickets (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT conversation_scores_band_ck CHECK (band IN ('excellent', 'good', 'fair', 'poor'))
);
CREATE INDEX IF NOT EXISTS conversation_scores_overall_idx ON conversation_scores (tenant_id, overall);

GRANT SELECT, INSERT, UPDATE, DELETE ON conversation_scores TO app_user;
ALTER TABLE conversation_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_scores FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conversation_scores_isolation ON conversation_scores;
CREATE POLICY conversation_scores_isolation ON conversation_scores
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

-- ── Agent persona (one row per tenant; the assistant's voice) ─────────────────
CREATE TABLE IF NOT EXISTS agent_persona (
  tenant_id    uuid PRIMARY KEY DEFAULT current_tenant() REFERENCES tenants (id) ON DELETE CASCADE,
  tone         text NOT NULL DEFAULT 'friendly',
  signature    text NOT NULL DEFAULT '',
  guardrails   text NOT NULL DEFAULT '',
  instructions text NOT NULL DEFAULT '',
  updated_at   timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON agent_persona TO app_user;
ALTER TABLE agent_persona ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_persona FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_persona_isolation ON agent_persona;
CREATE POLICY agent_persona_isolation ON agent_persona
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

-- ── Broadcast provenance: which saved segment (if any) an outbound was built from ─
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS segment_id uuid;
