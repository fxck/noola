-- Discord Phase 5 — on-demand /ask + /draft.
-- Splits the autoreply decision ledger into 'ambient' (the auto-reply engine's own turns) vs
-- 'on_demand' (an explicit /ask), so the two never contaminate each other's rate caps, and adds
-- the per-guild on-demand visibility toggle + command-registration bookkeeping.

ALTER TABLE autoreply_decisions ADD COLUMN IF NOT EXISTS source                 text NOT NULL DEFAULT 'ambient'; -- 'ambient'|'on_demand'
ALTER TABLE autoreply_decisions ADD COLUMN IF NOT EXISTS invoked_by_external_id text;
CREATE INDEX IF NOT EXISTS autoreply_decisions_source_idx ON autoreply_decisions (tenant_id, source, created_at);

ALTER TABLE autoreply_policy ADD COLUMN IF NOT EXISTS ondemand_enabled      boolean NOT NULL DEFAULT true;
ALTER TABLE autoreply_policy ADD COLUMN IF NOT EXISTS max_ondemand_per_hour integer NOT NULL DEFAULT 120;

ALTER TABLE discord_links ADD COLUMN IF NOT EXISTS ondemand_public        boolean NOT NULL DEFAULT true;
ALTER TABLE discord_links ADD COLUMN IF NOT EXISTS commands_registered_at timestamptz;
