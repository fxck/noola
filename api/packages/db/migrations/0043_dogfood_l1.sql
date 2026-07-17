-- Dogfood L1 — engine capabilities that let routing & surveys run as flows instead of bespoke
-- modules. Three additions:
--   1. assignment_cursors — persists the round-robin position for the strategy-aware `assign`
--      action (keyed by a caller-supplied cursorKey, e.g. a routing rule id). Replaces the
--      per-row routing_rules.rr_cursor with an engine-level, flow-addressable cursor store.
--   2. flow_dedupe — a generic once-per-(tenant, key) guard for at-most-once flow effects (the
--      `survey` action's "one survey per ticket"). Generalises survey_requests.
--   3. automations.managed_by — marks a seed automation projected from a Settings form
--      ('routing' | 'surveys'); null = a hand-authored flow. Progressive disclosure: the Studio
--      list badges managed rows "Managed in Settings", and graduating clears the flag.
-- Same FORCE-RLS tenant isolation as every other app table.

CREATE TABLE IF NOT EXISTS assignment_cursors (
  tenant_id  uuid NOT NULL,
  key        text NOT NULL,                 -- cursor scope: 'routing:<ruleId>' or 'assign:<strategy>:<pool>'
  cursor     bigint NOT NULL DEFAULT 0,      -- monotonic; the action reads (cursor-1) % pool then bumps
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON assignment_cursors TO app_user;
GRANT SELECT ON assignment_cursors TO event_relay;
ALTER TABLE assignment_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignment_cursors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS assignment_cursors_isolation ON assignment_cursors;
CREATE POLICY assignment_cursors_isolation ON assignment_cursors
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

CREATE TABLE IF NOT EXISTS flow_dedupe (
  tenant_id  uuid NOT NULL,
  dedupe_key text NOT NULL,                  -- e.g. 'survey:<ticketId>' — at-most-once per (tenant, key)
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, dedupe_key)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON flow_dedupe TO app_user;
GRANT SELECT ON flow_dedupe TO event_relay;
ALTER TABLE flow_dedupe ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_dedupe FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS flow_dedupe_isolation ON flow_dedupe;
CREATE POLICY flow_dedupe_isolation ON flow_dedupe
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE automations ADD COLUMN IF NOT EXISTS managed_by text;
CREATE INDEX IF NOT EXISTS automations_managed_by_idx
  ON automations (tenant_id, managed_by) WHERE managed_by IS NOT NULL;

-- Retire the modules routing/surveys replaced (dogfood L2). No BC to preserve (no users): the
-- round-robin cursor moved to assignment_cursors, and survey dedupe to flow_dedupe, so drop the
-- vestigial routing_rules.rr_cursor column and the survey_requests table outright.
ALTER TABLE routing_rules DROP COLUMN IF EXISTS rr_cursor;
DROP TABLE IF EXISTS survey_requests;
