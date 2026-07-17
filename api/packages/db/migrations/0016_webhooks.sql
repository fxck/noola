-- Slice 16 — Outbound webhooks. A tenant registers webhook URLs subscribed to events
-- (contact.created / contact.updated / ticket.created / message.created, plus a manual
-- 'ping' test). When a subscribed event fires, the api POSTs an HMAC-signed JSON payload
-- and records the delivery outcome. Same FORCE-RLS discipline as every tenant table.
--
-- `webhooks.secret` is a 32-byte hex HMAC key, returned to the caller ONLY on create;
-- list/get never echo it (the app selects a has_secret flag instead). `events = '{}'`
-- means "all events". `webhook_deliveries` is the per-fire audit trail.

CREATE TABLE IF NOT EXISTS webhooks (
  tenant_id  uuid NOT NULL,
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  url        text NOT NULL,
  events     text[] NOT NULL DEFAULT '{}',
  secret     text NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  tenant_id   uuid NOT NULL,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  webhook_id  uuid NOT NULL,
  event       text NOT NULL,
  ok          boolean NOT NULL DEFAULT false,
  status_code int,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_recent_idx
  ON webhook_deliveries (tenant_id, webhook_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON webhooks TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_deliveries TO app_user;
-- event_relay (BYPASSRLS) reads for any future relay / backfill.
GRANT SELECT ON webhooks TO event_relay;
GRANT SELECT ON webhook_deliveries TO event_relay;

ALTER TABLE webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhooks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS webhooks_isolation ON webhooks;
CREATE POLICY webhooks_isolation ON webhooks
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS webhook_deliveries_isolation ON webhook_deliveries;
CREATE POLICY webhook_deliveries_isolation ON webhook_deliveries
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
