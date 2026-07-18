-- Model-B branded email: per-tenant custom SENDING domains (the Intercom "custom email domain"
-- feature). A tenant verifies their OWN domain (e.g. zerops.io) so outbound ticket replies send
-- AS support@theirdomain with real DKIM/SPF — not from the shared platform domain. The email
-- provider (Resend) holds the authoritative domain object; we cache its id + verification status
-- + the DNS records the tenant must publish so the settings wizard can display them and poll.
--
-- Scope split: INBOUND routing (which address → which tenant) stays in email_routes; this table
-- governs OUTBOUND sending identity + deliverability only. RLS-isolated tenant data (unlike the
-- unpolicied email_routes, which is resolved pre-tenant-context).
CREATE TABLE IF NOT EXISTS email_sending_domains (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL DEFAULT current_tenant(),
  domain          text NOT NULL,
  provider        text NOT NULL DEFAULT 'resend',
  -- The provider's domain-object id (Resend domain id); null when tracked locally only (no API key,
  -- the tenant is adding the domain in the provider dashboard by hand).
  provider_id     text,
  -- pending (created, DNS not yet verified) | verifying | verified | failed | not_started (local-only,
  -- no provider object yet). Mirrors the provider's own status vocabulary where one exists.
  status          text NOT NULL DEFAULT 'pending',
  -- The DNS records the tenant must publish (SPF/DKIM/DMARC/MX), as returned by the provider. Public
  -- DNS config — safe to echo back verbatim (nothing secret lives here).
  records         jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_checked_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, domain)
);
ALTER TABLE email_sending_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_sending_domains FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY email_sending_domains_iso ON email_sending_domains
    USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON email_sending_domains TO app_user;
