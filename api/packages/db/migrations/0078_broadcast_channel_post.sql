-- 0078_broadcast_channel_post — Discord rework Phase 4.
-- A Discord "broadcast" is NOT N per-recipient DMs (that path fired a user id as a channel →
-- Unknown-Channel 10003, never delivered, and mass-DMing a community is a ban/spam vector).
-- The right primitive is ONE post to a designated channel/announcement, optionally pinging a
-- single role, optionally as an embed. audience_kind selects the path: 'segment' (DEFAULT) keeps
-- every existing broadcast on the per-recipient contact-segment path byte-for-byte; only
-- 'discord_channel' branches to the channel-post path. All additive, idempotent.
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS audience_kind   text NOT NULL DEFAULT 'segment'; -- 'segment' | 'discord_channel'
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS target_ref      text;    -- a SPECIFIC channel id (disambiguates a multi-guild tenant)
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS mention_role_id text;    -- optional role to ping (allowedMentions-gated; never @everyone/@here)
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS as_embed        boolean NOT NULL DEFAULT false;
-- NOTE: broadcast_recipients.contact_id is ALREADY nullable with NO FK to contacts (confirmed in
--   Phase 0) → the single channel-post log row (null contact_id, handle = the channel id) needs no
--   ALTER here. Deliberately omitted.
