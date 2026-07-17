-- Slice 13 — Autoreply approval queue. AI-drafted replies that were NOT auto-sent —
-- suggest_only mode, and auto-mode drafts held by the weak-retrieval gate — land here
-- as reviewable items a human can Send / Edit+Send / Dismiss. One row per triggering
-- inbound customer message (UNIQUE (tenant_id, message_id) = idempotency guard, so a
-- re-ingest/replay conflicts and no-ops). Same FORCE-RLS discipline as autoreply_policy.

CREATE TABLE IF NOT EXISTS autoreply_queue (
  tenant_id  uuid NOT NULL,
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  ticket_id  uuid NOT NULL,
  message_id uuid NOT NULL,                            -- inbound customer message that triggered the draft
  draft_body text NOT NULL,
  meta       jsonb,                                     -- same shape as messages.meta
  reason     text NOT NULL DEFAULT 'suggest_only',      -- suggest_only | weak_retrieval
  status     text NOT NULL DEFAULT 'pending',           -- pending | sent | dismissed
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, message_id),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES tickets (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT autoreply_queue_status_ck CHECK (status IN ('pending','sent','dismissed')),
  CONSTRAINT autoreply_queue_reason_ck CHECK (reason IN ('suggest_only','weak_retrieval'))
);
CREATE INDEX IF NOT EXISTS autoreply_queue_pending_idx
  ON autoreply_queue (tenant_id, created_at DESC) WHERE status = 'pending';

GRANT SELECT, INSERT, UPDATE, DELETE ON autoreply_queue TO app_user;
GRANT SELECT ON autoreply_queue TO event_relay;

ALTER TABLE autoreply_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE autoreply_queue FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS autoreply_queue_isolation ON autoreply_queue;
CREATE POLICY autoreply_queue_isolation ON autoreply_queue
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
