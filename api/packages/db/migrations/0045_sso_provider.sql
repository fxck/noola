-- Enterprise SSO, on the first-party @better-auth/sso plugin (replaces the bespoke sso_connections
-- layer). The plugin owns OIDC discovery + code exchange, JWKS signature verification, SAML, and
-- session creation; this table is its provider store. Shape matches the plugin's model (double-
-- quoted camelCase, text ids) exactly, like the other better-auth tables in 0021.
--
-- `organizationId` pins each provider to a tenant (organization.id::uuid == tenant uuid, findings
-- Q1); the login-time provisionUser hook reads it to place the JIT user. `domain` routes an email
-- to its provider. `oidcConfig`/`samlConfig` are JSON blobs the plugin (de)serializes — the client
-- secret lives inside oidcConfig (auth DB, auth_user-only, same trust tier as password hashes).
--
-- `createdAt` isn't in the plugin's field set, but a DB DEFAULT populates it on every adapter
-- insert (unlisted columns fall back to their default), giving our admin view a real timestamp.
CREATE TABLE IF NOT EXISTS "ssoProvider" (
  "id"             text NOT NULL PRIMARY KEY,
  "issuer"         text NOT NULL,
  "oidcConfig"     text,
  "samlConfig"     text,
  "userId"         text REFERENCES "user" ("id") ON DELETE CASCADE,
  "providerId"     text NOT NULL UNIQUE,
  "organizationId" text,
  "domain"         text NOT NULL,
  "createdAt"      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "ssoProvider_domain_idx" ON "ssoProvider" (lower("domain"));
CREATE INDEX IF NOT EXISTS "ssoProvider_org_idx" ON "ssoProvider" ("organizationId");

GRANT SELECT, INSERT, UPDATE, DELETE ON "ssoProvider" TO auth_user;

-- Retire the bespoke layer (no backwards-compat: no live SSO users). The old table + its dependent
-- objects go; the plugin table above is the sole SSO store now.
DROP TABLE IF EXISTS sso_connections;
DROP TABLE IF EXISTS sso_login_states;
