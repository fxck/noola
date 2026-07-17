-- Slice 03 — agent operating layer. Assignment + whose-turn on tickets.
-- Executed as superuser, idempotent.

-- assignee_id: a ticket's owner. The composite FK (tenant_id, assignee_id) → users
-- means a ticket can ONLY be assigned to a user in the SAME tenant — cross-tenant
-- assignment is impossible by the key, not by app logic. NULL = unassigned (MATCH
-- SIMPLE skips the FK check when assignee_id is NULL).
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS assignee_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tickets_assignee_fk') THEN
    ALTER TABLE tickets
      ADD CONSTRAINT tickets_assignee_fk
      FOREIGN KEY (tenant_id, assignee_id) REFERENCES users (tenant_id, id) ON DELETE SET NULL;
  END IF;
END $$;

-- whose_turn: the rule-based "needs reply" state. 'us' = a customer is waiting on us
-- (Needs reply); 'customer' = we replied, ball in their court. NULL until the first
-- message sets it. ingestInbound() maintains it: customer msg → 'us', agent reply → 'customer'.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS whose_turn text;
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_whose_turn_chk;
ALTER TABLE tickets ADD CONSTRAINT tickets_whose_turn_chk
  CHECK (whose_turn IS NULL OR whose_turn IN ('us', 'customer'));

-- Views are index-backed: Needs reply and My/Unassigned queues over open tickets.
CREATE INDEX IF NOT EXISTS tickets_tenant_needsreply_idx
  ON tickets (tenant_id, whose_turn) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS tickets_tenant_assignee_idx
  ON tickets (tenant_id, assignee_id) WHERE status = 'open';
