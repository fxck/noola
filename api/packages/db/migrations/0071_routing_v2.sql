-- Wave 3 item 12 — Routing v2: per-agent routing signals. Skills gate which pool members a
-- rule may pick; out_of_office removes an agent from every pool (with optional one-shot
-- reassign of their open queue); max_open_tickets is a soft load cap enforced at pool-pick
-- time (NULL = uncapped). All three live on the app-side users row — better-auth projection
-- upserts only email/name/role, so these survive re-projection.

ALTER TABLE users ADD COLUMN IF NOT EXISTS skills text[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS out_of_office boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS max_open_tickets integer;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_max_open_tickets_ck;
ALTER TABLE users ADD CONSTRAINT users_max_open_tickets_ck
  CHECK (max_open_tickets IS NULL OR max_open_tickets > 0);

-- A rule can demand skills: pool candidates must carry EVERY listed skill.
ALTER TABLE routing_rules ADD COLUMN IF NOT EXISTS required_skills text[] NOT NULL DEFAULT '{}';
