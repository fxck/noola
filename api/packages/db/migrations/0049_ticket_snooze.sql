-- Snooze / scheduled reopen. A ticket can be parked until a future time: while snoozed it's hidden
-- from the open queues; once the time passes it resurfaces (a per-minute sweep clears the flag and
-- flips whose_turn back to 'us' so it reads as needing attention). NULL = not snoozed (default,
-- unchanged). One nullable column + a partial index for the cheap "due to wake" sweep.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS snoozed_until timestamptz;
CREATE INDEX IF NOT EXISTS tickets_snoozed_until_idx ON tickets (snoozed_until) WHERE snoozed_until IS NOT NULL;
