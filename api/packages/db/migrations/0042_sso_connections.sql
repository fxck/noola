-- Enterprise SSO connections — per-tenant OIDC / SAML identity-provider config, keyed by the
-- organisation's email domain so the login page can route a user to their IdP.
--
-- Intentionally NOT force-RLS (unlike the other app tables): SSO discovery is a PRE-AUTH lookup
-- by email domain — the user has no session (hence no tenant) yet, so the lookup must read across
-- tenants by domain. Every ADMIN query is instead explicitly scoped by the authoritative session
-- tenant_id, and the only secret (client_secret_enc) is encrypted at rest (crypto.ts). email_domain
-- is globally unique, so a domain resolves to exactly one IdP.
CREATE TABLE IF NOT EXISTS sso_connections (
  tenant_id         uuid NOT NULL,
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  provider          text NOT NULL DEFAULT 'oidc',   -- oidc | saml
  name              text NOT NULL,                  -- display name (e.g. "Okta", "Azure AD")
  email_domain      text NOT NULL,                  -- routes login by the user's email domain
  issuer            text,                           -- OIDC issuer / SAML entityID
  authorize_url     text,                           -- OIDC authorization endpoint / SAML SSO URL
  token_url         text,                           -- OIDC token endpoint (unused for SAML)
  client_id         text,
  client_secret_enc text,                           -- encrypted at rest; used at the token exchange
  enabled           boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (email_domain)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON sso_connections TO app_user;
GRANT SELECT ON sso_connections TO event_relay;
CREATE INDEX IF NOT EXISTS sso_connections_tenant_idx ON sso_connections (tenant_id);
