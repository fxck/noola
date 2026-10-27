-- Wave 2 (outbound engine): frequency & scheduling. A broadcast is either 'oneshot'
-- (send now, or at send_at — status 'scheduled' until the worker fires it) or 'continuous'
-- (status 'active': the worker re-resolves the audience each tick and sends ONCE to each
-- contact the first time they match — broadcast_recipients.contact_id is the dedupe).
-- stop_at ends a continuous broadcast ('stopped'); cancel returns 'scheduled' → 'draft'.
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'oneshot';
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS send_at timestamptz;
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS stop_at timestamptz;

ALTER TABLE broadcasts DROP CONSTRAINT IF EXISTS broadcasts_mode_ck;
ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_mode_ck CHECK (mode IN ('oneshot','continuous'));
ALTER TABLE broadcasts DROP CONSTRAINT IF EXISTS broadcasts_status_ck;
ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_status_ck
  CHECK (status IN ('draft','scheduled','sending','active','sent','failed','stopped'));

-- The scheduler's cross-tenant discovery scan (event_relay, BYPASSRLS) only ever wants the
-- few live rows — a partial index keeps it O(live), not O(history).
CREATE INDEX IF NOT EXISTS broadcasts_scheduler_idx ON broadcasts (status, send_at)
  WHERE status IN ('scheduled','active');
