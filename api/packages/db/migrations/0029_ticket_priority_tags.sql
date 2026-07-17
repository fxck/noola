-- Deep ticketing (slice A): first-class priority + free-form tags on tickets, so the ticket
-- list can filter/sort/segment beyond the inbox's status/assignee/whose-turn views.
-- Additive + idempotent; RLS already covers the tickets table (0000_init FORCE RLS).

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal';
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_priority_chk;
ALTER TABLE tickets ADD CONSTRAINT tickets_priority_chk
  CHECK (priority IN ('low', 'normal', 'high', 'urgent'));

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';

-- Sort hot path (updated_at is the default order) + a GIN index so tag filters stay cheap.
CREATE INDEX IF NOT EXISTS tickets_updated_at_idx ON tickets (tenant_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS tickets_tags_idx ON tickets USING gin (tags);
