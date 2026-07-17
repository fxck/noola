-- Routing & assignment rules — an ordered, per-tenant list of auto-assignment rules evaluated
-- when a brand-new ticket lands. The first rule whose (ANDed) conditions match wins; its strategy
-- (specific / round_robin / least_loaded) picks an assignee from assignee_ids (empty pool =
-- every agent), and it may also set a priority and append tags. This is the EDITOR store — the
-- rules are projected into managed automations the engine dispatches (dogfood L2); round-robin
-- position lives in assignment_cursors (0043). Same FORCE-RLS isolation as the other app tables.
CREATE TABLE IF NOT EXISTS routing_rules (
  tenant_id     uuid NOT NULL,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  position      integer NOT NULL DEFAULT 0,
  enabled       boolean NOT NULL DEFAULT true,
  conditions    jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{field, op, value}], ANDed; [] = catch-all
  strategy      text NOT NULL DEFAULT 'round_robin',  -- specific | round_robin | least_loaded
  assignee_ids  uuid[] NOT NULL DEFAULT '{}',         -- pool (or single for 'specific'); [] = all agents
  set_priority  text,                                 -- optional: force a priority on match
  add_tags      text[] NOT NULL DEFAULT '{}',         -- optional: append these tags on match
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON routing_rules TO app_user;
GRANT SELECT ON routing_rules TO event_relay;
ALTER TABLE routing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_rules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS routing_rules_isolation ON routing_rules;
CREATE POLICY routing_rules_isolation ON routing_rules
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
CREATE INDEX IF NOT EXISTS routing_rules_order_idx ON routing_rules (tenant_id, position);
