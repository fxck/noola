-- Slice 17 — Broadcast. Compose a subject+body, target a filtered SEGMENT of the
-- contacts directory (the same q/company/attrKey/attrValue filter the directory uses),
-- and mass-send via the one outbound-email seam (Mailpit in dev), logging per-recipient
-- delivery. Same FORCE-RLS discipline as every tenant table.
--
-- `broadcasts.segment` stores the contacts filter used (so a send is reproducible and the
-- UI can show the target). `broadcast_recipients` is the per-address delivery audit trail —
-- one row per resolved recipient (deduped by lowercased email), carrying send status + error.
-- Counters on the parent (recipient_count/sent_count/failed_count) tick as the async send
-- runs so the UI can watch progress live; status walks draft → sending → sent|failed.

CREATE TABLE IF NOT EXISTS broadcasts (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  subject text NOT NULL, body text NOT NULL DEFAULT '',
  segment jsonb NOT NULL DEFAULT '{}',           -- the contacts filter used
  status text NOT NULL DEFAULT 'draft',          -- draft|sending|sent|failed
  recipient_count int NOT NULL DEFAULT 0, sent_count int NOT NULL DEFAULT 0, failed_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT broadcasts_status_ck CHECK (status IN ('draft','sending','sent','failed'))
);
CREATE TABLE IF NOT EXISTS broadcast_recipients (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  broadcast_id uuid NOT NULL, contact_id uuid, email text NOT NULL,
  status text NOT NULL DEFAULT 'pending',        -- pending|sent|failed
  error text, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS broadcast_recipients_idx ON broadcast_recipients (tenant_id, broadcast_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON broadcasts TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON broadcast_recipients TO app_user;
-- event_relay (BYPASSRLS) reads for any future relay / backfill.
GRANT SELECT ON broadcasts TO event_relay;
GRANT SELECT ON broadcast_recipients TO event_relay;

ALTER TABLE broadcasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcasts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS broadcasts_isolation ON broadcasts;
CREATE POLICY broadcasts_isolation ON broadcasts
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE broadcast_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcast_recipients FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS broadcast_recipients_isolation ON broadcast_recipients;
CREATE POLICY broadcast_recipients_isolation ON broadcast_recipients
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
