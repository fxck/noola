-- Scheduled source re-crawl. A source can carry an auto-refresh cadence; a per-minute scheduler
-- re-syncs sources whose interval has elapsed (reusing the existing replace-on-sync engine), so a
-- docs URL / GitHub repo stays live in the KB instead of being a one-shot import. NULL = manual
-- only (the default, unchanged behavior). No new table — one nullable column on `sources`.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS refresh_interval_minutes integer;
-- Partial index over the auto-refresh subset so the cross-tenant "due" sweep stays cheap.
CREATE INDEX IF NOT EXISTS sources_refresh_due_idx
  ON sources (last_synced_at)
  WHERE refresh_interval_minutes IS NOT NULL;
