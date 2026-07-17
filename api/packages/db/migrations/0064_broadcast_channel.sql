-- Multi-channel broadcasts. A broadcast now picks ONE channel (email | discord | telegram |
-- whatsapp | …) and sends to the segment's contacts through that channel's registry driver,
-- using each contact's per-channel identity (contact_identities, 0062). Two changes:
--
--   1. broadcasts.channel — which driver delivers this broadcast. 'email' keeps the original
--      outbound-email path (contacts.email); any other value resolves recipients from
--      contact_identities and dispatches via the channel registry.
--   2. broadcast_recipients.email → handle — the delivery-log column now stores an email
--      address OR a channel handle (chat id, phone, discord user id). Clean rename, no BC
--      shim (no real users).

ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'email';

-- Postgres has no RENAME COLUMN IF EXISTS — guard via information_schema so the rename
-- stays idempotent under migrate.ts's run-everything-every-time model.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'broadcast_recipients' AND column_name = 'email'
  ) THEN
    ALTER TABLE broadcast_recipients RENAME COLUMN email TO handle;
  END IF;
END $$;
