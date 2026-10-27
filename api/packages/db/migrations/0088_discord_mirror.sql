-- Discord forum ops-mirror (PILOT-AND-DISCORD-PLAN Part 1) — a team-facing forum surface for
-- tickets that originate on OTHER channels (email/widget/…). One forum post per mirrored ticket;
-- responders triage/answer from Discord, the customer never sees Discord.
--
-- RLS posture: all three tables are relay-accessible (GRANT to event_relay, NO RLS) because the
-- gateway resolves "is this thread a mirror post?" BEFORE any tenant context exists — the exact
-- rationale as discord_links / discord_channel_bindings. API CRUD scopes by tenant_id in the query.

-- One binding per (tenant, forum channel): where mirrored posts go + who may promote-to-reply +
-- which tickets auto-mirror. filter = {priorities:[],tags:[],topics:[],teamIds:[],channels:[]} —
-- empty arrays/absent keys match everything (an enabled binding with an empty filter mirrors ALL
-- non-Discord tickets; the UI copy says so). attribution_mode: 'team' = outbound replies carry the
-- workspace persona (attribution_name), 'collaborator' = the Discord responder's display name.
CREATE TABLE IF NOT EXISTS discord_mirror_bindings (
  id                uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  guild_id          text NOT NULL,
  forum_channel_id  text NOT NULL,
  enabled           boolean NOT NULL DEFAULT true,
  responder_role_id text,                                  -- NULL = every guild member may promote (single-tenant pilot default)
  attribution_mode  text NOT NULL DEFAULT 'team' CHECK (attribution_mode IN ('team','collaborator')),
  attribution_name  text,                                  -- team persona ("Acme Support"); NULL = unsigned
  tag_map           jsonb NOT NULL DEFAULT '{}'::jsonb,    -- reserved: custom status/priority → forum-tag-name overrides
  filter            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, forum_channel_id)
);
CREATE INDEX IF NOT EXISTS discord_mirror_bindings_tenant_idx ON discord_mirror_bindings (tenant_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON discord_mirror_bindings TO event_relay;

-- ticket → its forum post. post_thread_id starts as a 'pending:<ticket>' claim marker (the INSERT
-- is the idempotency claim taken BEFORE the Discord API call; failure deletes the row) and becomes
-- the real thread id once the post exists. UNIQUE(post_thread_id) also serves the reverse lookup
-- the gateway does on every thread message.
CREATE TABLE IF NOT EXISTS ticket_mirror (
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  ticket_id        uuid NOT NULL,
  binding_id       uuid REFERENCES discord_mirror_bindings (id) ON DELETE CASCADE,
  guild_id         text NOT NULL,
  forum_channel_id text NOT NULL,
  post_thread_id   text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, ticket_id),
  UNIQUE (post_thread_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON ticket_mirror TO event_relay;

-- Every responder/collaborator message posted INSIDE a mirror post: recorded as an internal note on
-- the ticket (note_id), promotable to a customer reply exactly once (promoted_at claim; the UPDATE
-- ... WHERE promoted_at IS NULL is the race guard). body is kept verbatim so promotion doesn't need
-- a Discord re-fetch.
CREATE TABLE IF NOT EXISTS ticket_mirror_messages (
  discord_message_id  text PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  ticket_id           uuid NOT NULL,
  post_thread_id      text NOT NULL,
  author_discord_id   text NOT NULL,
  author_display_name text,
  is_responder        boolean NOT NULL DEFAULT false,
  body                text NOT NULL,
  note_id             uuid,
  promoted_at         timestamptz,
  promoted_message_id uuid,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ticket_mirror_messages_ticket_idx ON ticket_mirror_messages (tenant_id, ticket_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON ticket_mirror_messages TO event_relay;
