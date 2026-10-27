-- Delivery quality (broadcast wave): capture provider delivery events (delivered / bounced /
-- complained) for broadcast emails, derive a REAL per-recipient delivery status beyond
-- "SMTP accepted the handoff", suppress hard-bounced + complained addresses from future sends,
-- and lay an append-only event backbone the analytics layer aggregates over time.
--
-- Before this, broadcast_recipients.status='sent' only meant nodemailer.sendMail didn't throw —
-- a bounced or complained address was invisible and kept being re-sent (worst in continuous mode).

-- Per-recipient delivery facts beyond the send attempt. status gains: delivered, bounced,
-- complained (the app enforces the recipient status enum — broadcast_recipients carries no CHECK
-- by design, unlike broadcasts).
ALTER TABLE broadcast_recipients ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
ALTER TABLE broadcast_recipients ADD COLUMN IF NOT EXISTS bounced_at timestamptz;
ALTER TABLE broadcast_recipients ADD COLUMN IF NOT EXISTS bounce_kind text;      -- 'hard' | 'soft'
ALTER TABLE broadcast_recipients ADD COLUMN IF NOT EXISTS complained_at timestamptz;
ALTER TABLE broadcast_recipients ADD COLUMN IF NOT EXISTS unsubscribed_at timestamptz; -- this recipient opted out
-- The Message-ID we stamp per send so a provider event can be matched back to the exact row.
ALTER TABLE broadcast_recipients ADD COLUMN IF NOT EXISTS message_id text;
CREATE INDEX IF NOT EXISTS broadcast_recipients_msgid_idx
  ON broadcast_recipients (tenant_id, message_id) WHERE message_id IS NOT NULL;
-- Address lookup for the (address -> latest recipient) fallback match when no Message-ID echo.
CREATE INDEX IF NOT EXISTS broadcast_recipients_addr_idx
  ON broadcast_recipients (tenant_id, lower(handle));

-- Append-only delivery-event backbone. One row per provider/engagement event; the analytics
-- layer buckets these over time and the recipient-status columns above are the derived head.
CREATE TABLE IF NOT EXISTS broadcast_events (
  tenant_id uuid NOT NULL DEFAULT current_tenant(),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  broadcast_id uuid,
  recipient_id uuid,
  contact_id uuid,
  type text NOT NULL,              -- sent|delivered|deferred|bounced|complained|opened|clicked|unsubscribed|failed
  address text,                    -- lowercased recipient address
  meta jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS broadcast_events_bcast_idx ON broadcast_events (tenant_id, broadcast_id, occurred_at);
CREATE INDEX IF NOT EXISTS broadcast_events_time_idx ON broadcast_events (tenant_id, occurred_at);

-- Address-level suppression: a hard bounce or spam complaint parks the address so no future
-- broadcast re-sends to it, INDEPENDENT of whether a contact exists. Distinct from
-- contacts.unsubscribed_at (a marketing opt-out on a known contact) — this is a deliverability
-- guard keyed by the raw address (a stale/typo address may have no contact at all).
CREATE TABLE IF NOT EXISTS email_suppressions (
  tenant_id uuid NOT NULL DEFAULT current_tenant(),
  address text NOT NULL,           -- lowercased
  reason text NOT NULL,            -- hard_bounce|complaint|manual|unsubscribe
  broadcast_id uuid,               -- the send that triggered it (provenance), nullable
  contact_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, address)
);
CREATE INDEX IF NOT EXISTS email_suppressions_created_idx ON email_suppressions (tenant_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON broadcast_events TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON email_suppressions TO app_user;
-- event_relay (BYPASSRLS) reads for any future relay / backfill (same convention as broadcasts).
-- The delivery-event webhook resolves the tenant via the inbound_handle relay, then writes
-- through a tenant-scoped app_user connection (withTenant) exactly like the inbound path — so it
-- does NOT need write grants under event_relay.
GRANT SELECT ON broadcast_events TO event_relay;
GRANT SELECT ON email_suppressions TO event_relay;

ALTER TABLE broadcast_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcast_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS broadcast_events_isolation ON broadcast_events;
CREATE POLICY broadcast_events_isolation ON broadcast_events
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE email_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_suppressions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS email_suppressions_isolation ON email_suppressions;
CREATE POLICY email_suppressions_isolation ON email_suppressions
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
