-- Discord rework Phase 2 — identity & classification.
-- Role-based responder-vs-seeker classification config on the (outside-RLS) discord_links row,
-- plus a teammate ↔ Discord-user directory so a team member's inbound resolves to their Noola seat.
-- Additive, idempotent, no backfill (no backwards compat).

ALTER TABLE discord_links ADD COLUMN IF NOT EXISTS team_role_ids      jsonb NOT NULL DEFAULT '[]'; -- → 'agent'/team
ALTER TABLE discord_links ADD COLUMN IF NOT EXISTS responder_role_ids jsonb NOT NULL DEFAULT '[]'; -- → 'community'
ALTER TABLE discord_links ADD COLUMN IF NOT EXISTS ignore_role_ids    jsonb NOT NULL DEFAULT '[]'; -- → drop

CREATE TABLE IF NOT EXISTS agent_channel_identities (
  tenant_id    uuid NOT NULL,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  channel_type text NOT NULL,
  external_id  text NOT NULL,                        -- discord user id for a teammate
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT agent_channel_identities_user_fk
    FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
  -- users PK is composite (tenant_id, id) — CONFIRMED in Phase 0, this FK is valid.
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_channel_identities_handle_uq
  ON agent_channel_identities (tenant_id, channel_type, lower(external_id));
ALTER TABLE agent_channel_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_channel_identities FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_channel_identities_isolation ON agent_channel_identities;
CREATE POLICY agent_channel_identities_isolation ON agent_channel_identities
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_channel_identities TO app_user;
