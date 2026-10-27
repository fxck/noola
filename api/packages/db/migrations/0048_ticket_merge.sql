-- Ticket merge: fold a duplicate ticket into a canonical one. The duplicate's messages move to the
-- canonical ticket and the duplicate is closed + flagged with `merged_into` (the canonical's id),
-- so the thread lives in one place. Self-referential within the tenant (no cross-tenant merge). A
-- nullable column — NULL means a normal, un-merged ticket (the default, unchanged).
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS merged_into uuid;
CREATE INDEX IF NOT EXISTS tickets_merged_into_idx ON tickets (tenant_id, merged_into) WHERE merged_into IS NOT NULL;
