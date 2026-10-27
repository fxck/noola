-- BYO Resend (bring-your-own email provider): per-tenant Resend credentials so a workspace can send
-- + receive through THEIR OWN Resend account instead of the shared platform key. One row per tenant.
--
--   api_key_enc        — the tenant's Resend API key (AES-256-GCM via crypto.ts), used for: outbound
--                        (Resend SMTP, user='resend' pass=key), the sending-domain wizard (domains
--                        created in the tenant's own account), and the inbound body/attachment fetch.
--   webhook_secret_enc — the tenant's Resend inbound webhook Svix signing secret (whsec_…), used to
--                        verify the per-tenant inbound webhook.
--   inbound_handle     — an opaque, globally-unique token. The tenant points their Resend
--                        `email.received` webhook at /email/inbound/resend/<handle>; the handle
--                        resolves the tenant BEFORE signature verification (solving the
--                        chicken-and-egg: Svix signs the raw body with the tenant's OWN secret, so we
--                        must know whose secret to verify with before we can trust the body).
--
-- Everything absent → the tenant falls back to the shared env account (RESEND_API_KEY /
-- RESEND_WEBHOOK_SECRET). RLS-isolated for tenant CRUD; the inbound-handle lookup reads pre-tenant
-- via the BYPASSRLS relay (like email_routes / channel_connections).
CREATE TABLE IF NOT EXISTS email_provider_settings (
  tenant_id          uuid NOT NULL DEFAULT current_tenant(),
  provider           text NOT NULL DEFAULT 'resend',
  api_key_enc        text,
  webhook_secret_enc text,
  inbound_handle     text NOT NULL,
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id),
  UNIQUE (inbound_handle)
);
ALTER TABLE email_provider_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_provider_settings FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY email_provider_settings_iso ON email_provider_settings
    USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON email_provider_settings TO app_user;
-- event_relay (BYPASSRLS) resolves the inbound webhook handle → tenant (+ decrypts the tenant's
-- secret/key) BEFORE any tenant context exists, exactly like email_routes / channel_connections.
GRANT SELECT ON email_provider_settings TO event_relay;
