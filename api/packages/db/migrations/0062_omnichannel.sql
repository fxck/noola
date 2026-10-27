-- Omnichannel unification (Intercom-style). A conversation (ticket) now belongs to a CONTACT and
-- can span channels; inbound threads onto the contact's open conversation instead of a per-channel
-- key. Three structural changes:
--
--   1. tickets.contact_id — the conversation's owner (the person), set at ingest from the resolved
--      identity. Nullable + ON DELETE SET NULL so deleting a directory contact never destroys history.
--   2. messages.channel_type / external_channel_id — channel is now a property of each MESSAGE (a
--      thread can hold email + chat + discord), and outbound routing reads the message's channel.
--   3. contact_identities — maps a per-channel handle (email address, discord user id, phone, chat id,
--      widget conversation id) to a contact, so the same person is recognized across channels. Exact
--      email match is the cross-channel unifier; opaque handles get their own identity row.
--
-- The old per-channel-key threading (tickets.external_channel_id lookup) is retired — clean break,
-- no backfill (no real users).

-- 1. Conversation ↔ contact ---------------------------------------------------
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS contact_id uuid;
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_contact_fk;
-- SET NULL must name the column subset (PG15+): a bare composite SET NULL nulls tenant_id
-- too, so deleting any contact that owned a ticket violated tickets.tenant_id NOT NULL.
ALTER TABLE tickets ADD CONSTRAINT tickets_contact_fk
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE SET NULL (contact_id);
CREATE INDEX IF NOT EXISTS tickets_contact_idx ON tickets (tenant_id, contact_id);

-- 2. Channel per message ------------------------------------------------------
ALTER TABLE messages ADD COLUMN IF NOT EXISTS channel_type text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS external_channel_id text;

-- 3. Contact identity map -----------------------------------------------------
CREATE TABLE IF NOT EXISTS contact_identities (
  tenant_id    uuid NOT NULL,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  contact_id   uuid NOT NULL,
  channel_type text NOT NULL,
  external_id  text NOT NULL,   -- the sender's stable per-channel handle
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE
);
-- One identity per (channel, handle) per tenant — the resolution key.
CREATE UNIQUE INDEX IF NOT EXISTS contact_identities_handle_uq
  ON contact_identities (tenant_id, channel_type, lower(external_id));
CREATE INDEX IF NOT EXISTS contact_identities_contact_idx ON contact_identities (tenant_id, contact_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON contact_identities TO app_user;
GRANT SELECT ON contact_identities TO event_relay;

-- Merging a contact re-homes its timeline events onto the kept contact — app_user needs UPDATE
-- (0059 granted only SELECT/INSERT/DELETE).
GRANT UPDATE ON contact_events TO app_user;

ALTER TABLE contact_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_identities FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contact_identities_isolation ON contact_identities;
CREATE POLICY contact_identities_isolation ON contact_identities
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
