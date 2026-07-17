-- Wave 2 (outbound engine): engagement tracking + goals. Broadcast emails carry an open
-- pixel and signed click-redirect links (tracking.ts) writing FIRST-touch timestamps onto
-- the recipient row; destinations get UTM parameters appended at send. A broadcast can name
-- a GOAL: a contact_events name counted as a conversion when the recipient emits it within
-- goal_days of their send.
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS goal_event text;
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS goal_days int NOT NULL DEFAULT 7;
ALTER TABLE broadcast_recipients ADD COLUMN IF NOT EXISTS opened_at timestamptz;
ALTER TABLE broadcast_recipients ADD COLUMN IF NOT EXISTS clicked_at timestamptz;
