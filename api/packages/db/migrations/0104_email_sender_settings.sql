-- Teammate sending identity (Intercom "sending address" parity). Per-tenant choice of which address
-- outbound ticket replies are sent FROM:
--   'shared'   — always the tenant's support address (support@domain), with the teammate's name shown
--                as the From display name ("Aleš from Zerops" <support@zerops.io>). Default.
--   'teammate' — send from the replying teammate's OWN address (ales@zerops.io) when that address's
--                domain is a verified sending domain; otherwise fall back to the shared support address.
--
-- The per-ticket Reply-To (support+t.<id>.<sig>@domain) and Message-ID stay on the SUPPORT address
-- regardless, so inbound routing + threading are unaffected by who a reply is From. RLS-isolated;
-- read only within tenant context on the send path (no pre-tenant relay read needed).
CREATE TABLE IF NOT EXISTS email_sender_settings (
  tenant_id  uuid NOT NULL DEFAULT current_tenant(),
  mode       text NOT NULL DEFAULT 'shared',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id),
  CONSTRAINT email_sender_mode_chk CHECK (mode IN ('shared', 'teammate'))
);
ALTER TABLE email_sender_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_sender_settings FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY email_sender_settings_iso ON email_sender_settings
    USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON email_sender_settings TO app_user;
