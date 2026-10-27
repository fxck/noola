-- Spam handling + sender blocklist (the "Mark as spam" action).
--
-- A spammed ticket and its auto-created lead are SOFT-hidden (spam_at timestamp), not deleted, so
-- "Unspam" fully restores both. All the list/view queries gain `spam_at IS NULL` so spam drops out of
-- every default surface; a dedicated Spam view flips the predicate to see what was hidden. Permanent
-- removal stays a separate, explicit action (contact delete/erase) — spam is reversible by design.
--
-- blocked_senders is the ingest guard: an inbound whose sender matches a live block is dropped BEFORE
-- a ticket/lead is created (so a spammer who rotates subjects can't keep reopening work). `scope`:
--   'address' → match the exact handle (e.g. vlastimila@spam.example)
--   'domain'  → match the handle's domain (e.g. spam.example) — every local-part under it
-- `handle` is stored lowercased; the ingest check compares lowercased.

ALTER TABLE tickets  ADD COLUMN IF NOT EXISTS spam_at timestamptz;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS spam_at timestamptz;

-- Spam tickets/leads leave the hot open-queue paths entirely — partial indexes keep the common
-- `spam_at IS NULL` scans cheap without bloating the closed/spam minority.
CREATE INDEX IF NOT EXISTS tickets_live_idx  ON tickets  (tenant_id, updated_at DESC) WHERE spam_at IS NULL;
CREATE INDEX IF NOT EXISTS contacts_live_idx ON contacts (tenant_id, updated_at DESC) WHERE spam_at IS NULL;

CREATE TABLE IF NOT EXISTS blocked_senders (
  tenant_id    uuid NOT NULL,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  channel_type text NOT NULL DEFAULT 'email',
  scope        text NOT NULL DEFAULT 'address',   -- 'address' | 'domain'
  handle       text NOT NULL,                     -- lowercased address or bare domain
  reason       text,
  created_by   uuid,                              -- the teammate who blocked (nullable = system)
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

-- One block per (tenant, channel, scope, handle) — re-blocking the same sender is idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS blocked_senders_uniq
  ON blocked_senders (tenant_id, channel_type, scope, lower(handle));
-- The ingest lookup path: by (tenant, channel, handle).
CREATE INDEX IF NOT EXISTS blocked_senders_lookup_idx
  ON blocked_senders (tenant_id, channel_type, lower(handle));

GRANT SELECT, INSERT, UPDATE, DELETE ON blocked_senders TO app_user;
GRANT SELECT ON blocked_senders TO event_relay;
ALTER TABLE blocked_senders ENABLE ROW LEVEL SECURITY;
ALTER TABLE blocked_senders FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS blocked_senders_isolation ON blocked_senders;
CREATE POLICY blocked_senders_isolation ON blocked_senders
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
