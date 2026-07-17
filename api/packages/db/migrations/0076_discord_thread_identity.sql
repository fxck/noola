-- Discord rework Phase 1 — thread = ticket, per-message author identity, answer arbitration,
-- guild-level config + per-channel bindings. All additive / IF NOT EXISTS — re-runs idempotently.

-- (1) THREAD = TICKET — key decoupled from the retargetable external_channel_id.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS external_thread_id   text;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS external_parent_id   text;  -- forum/text channel id
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS external_thread_kind text;  -- 'text_thread'|'forum_post'|'channel'
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS external_guild_id    text;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS support_mode text NOT NULL DEFAULT 'staffed'; -- 'staffed'|'community'
CREATE UNIQUE INDEX IF NOT EXISTS tickets_thread_uq
  ON tickets (tenant_id, channel_type, external_thread_id)
  WHERE external_thread_id IS NOT NULL;
-- ⚠ PARTIAL index → the atomic upsert MUST repeat the WHERE predicate in ON CONFLICT
--   or inference fails and the write falls back to a racy path (see ingest.ts thread branch).

-- (2) PER-MESSAGE AUTHOR IDENTITY — denormalized name/avatar freeze identity at send time.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS author_kind                text; -- 'customer'|'agent'|'ai'|'community' (null ⇒ derive)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS author_contact_id          uuid; -- customer/participant → contacts; agents use author_id
ALTER TABLE messages ADD COLUMN IF NOT EXISTS author_external_name       text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS author_external_avatar_url text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at                 timestamptz; -- §5.6 soft-tombstone
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_author_contact_fk;
ALTER TABLE messages ADD CONSTRAINT messages_author_contact_fk
  FOREIGN KEY (tenant_id, author_contact_id) REFERENCES contacts (tenant_id, id)
  ON DELETE SET NULL;                                  -- same composite-FK pattern as 0062
-- attachment-only / embed-only inbound reuses the existing attachment plumbing (mig 0061); no new col.

-- (3) ANSWER ARBITRATION — one claim per turn, channel-agnostic (claim taken AFTER gates, §5.2).
CREATE TABLE IF NOT EXISTS answer_claims (
  tenant_id  uuid NOT NULL,
  message_id uuid NOT NULL,          -- the triggering (customer) message
  claimant   text NOT NULL,          -- 'autoreply'|'automations'|'on_demand'
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, message_id)                -- first INSERT wins; others no-op
);
ALTER TABLE answer_claims ENABLE  ROW LEVEL SECURITY;
ALTER TABLE answer_claims FORCE   ROW LEVEL SECURITY;
DROP POLICY IF EXISTS answer_claims_isolation ON answer_claims;
CREATE POLICY answer_claims_isolation ON answer_claims
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
GRANT SELECT, INSERT ON answer_claims TO app_user;      -- claimAnswer runs via app_user/withTenant (INSERT covered)
GRANT SELECT, DELETE ON answer_claims TO event_relay;   -- ⚠ REQUIRED: the server.ts prune runs on relayPool (role
--   event_relay). BYPASSRLS bypasses ROW policies, NOT table-level GRANT ACLs — without this DELETE the prune
--   throws permission-denied, is swallowed by its .catch(()=>{}), and the table grows unbounded.
-- Bounded growth: pruned by the housekeeping interval (server.ts) — DELETE WHERE created_at < now() - interval '2 days'.

-- (4) GUILD-LEVEL CONFIG (mode-neutral) — OUTSIDE RLS, co-located with discord_links.
ALTER TABLE discord_links ADD COLUMN IF NOT EXISTS default_mode        text NOT NULL DEFAULT 'staffed';
ALTER TABLE discord_links ADD COLUMN IF NOT EXISTS default_author_kind text NOT NULL DEFAULT 'customer';

-- (5) PER-CHANNEL BINDINGS — OUTSIDE RLS (same rationale as discord_links). mode='off' ⇒ not monitored.
CREATE TABLE IF NOT EXISTS discord_channel_bindings (
  guild_id       text NOT NULL,
  channel_id     text NOT NULL,                     -- channel, forum, or category id
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  kind           text NOT NULL DEFAULT 'text',      -- 'text'|'forum'|'category'
  mode           text NOT NULL DEFAULT 'staffed',   -- 'staffed'|'community'|'off'
  is_broadcast   boolean NOT NULL DEFAULT false,    -- announcement target
  require_thread boolean NOT NULL DEFAULT true,     -- top-level messages ignored unless false
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, channel_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON discord_channel_bindings TO event_relay;  -- NO RLS
