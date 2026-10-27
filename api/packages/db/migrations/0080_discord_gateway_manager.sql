-- Discord Phase 6 — gateway manager + per-tenant BYO bots.
-- discord_bots is the registry the gateway manager opens: NULL tenant_id = the shared/platform bot
-- (token from DISCORD_BOT_TOKEN via token_env); a scope='tenant' row is a customer's own bot with an
-- encrypted token (crypto.ts "v1:" blob, same MODEL_KEY_SECRET seam as integrations). Outside RLS
-- (like discord_links) — the manager reads it cross-tenant on the BYPASSRLS relay role; the API scopes
-- CRUD by tenant_id in the query. Per-tenant bots are PROD-GATED at the manager (never opened from
-- dev/stage) so a customer's live bot can't be double-consumed from a non-prod replica.

CREATE TABLE IF NOT EXISTS discord_bots (
  id                 uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id          uuid REFERENCES tenants (id) ON DELETE CASCADE,   -- NULL = shared/platform bot
  label              text,
  application_id     text,
  bot_user_id        text,
  token_enc          text,                                             -- crypto.ts "v1:" blob; NULL for the env-backed shared bot
  token_env          text,                                             -- env var name for the shared bot
  scope              text NOT NULL DEFAULT 'shared' CHECK (scope IN ('shared','tenant')),
  enabled            boolean NOT NULL DEFAULT true,
  disabled_reason    text,                                             -- poison-token / verification-blocked quarantine
  guild_count        int  NOT NULL DEFAULT 0,
  shard_count        int  NOT NULL DEFAULT 1,
  verification_state text NOT NULL DEFAULT 'unverified',
  last_ready_at      timestamptz,
  last_disconnect_at timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS discord_bots_tenant_idx ON discord_bots (tenant_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON discord_bots TO event_relay;  -- NO RLS (relay-scoped, like discord_links)

ALTER TABLE discord_links ADD COLUMN IF NOT EXISTS bot_id uuid;
-- Guarded FK: ADD CONSTRAINT is non-idempotent, so swallow the duplicate on re-run.
DO $$ BEGIN
  ALTER TABLE discord_links
    ADD CONSTRAINT discord_links_bot_fk FOREIGN KEY (bot_id) REFERENCES discord_bots (id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
