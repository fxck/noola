-- 0098 — customers + Discord audit remediation (identity linkage columns).
--
-- author_user_id: persist WHICH Noola user authored a mirrored Discord message, so a promoted reply
--   or note stays linked to their seat immutably — independent of any later identity re-mapping.
--   Populated from resolveTeammate() in discord-mirror.ts (handleMirrorPostMessage / handleMirrorReaction).
--
-- author_external_id: give messages the raw per-channel author id (e.g. the Discord user id) so
--   non-customer channel responders (community / team-role) can be correlated across tickets and
--   back-linked to an agent_channel_identities seat or a contact when later identified.
ALTER TABLE ticket_mirror_messages ADD COLUMN IF NOT EXISTS author_user_id uuid;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS author_external_id text;
