-- Public API keys (Wave A — extensibility spine). A SECRET server-to-server key
-- (sk_...) for the public API surface, unlike widget_keys (public/embeddable).
-- Stored HASHED (sha256) — the plaintext is shown once at creation and is never
-- retrievable afterward. Like widget_keys, DELIBERATELY OUTSIDE RLS: the key is
-- resolved to a tenant from an inbound request BEFORE any tenant context exists,
-- so it is read on the BYPASSRLS event_relay role. Management endpoints carry an
-- explicit tenant_id predicate (server-authoritative session tenant) as the guard.
CREATE TABLE IF NOT EXISTS api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name         text,
  key_prefix   text NOT NULL,               -- display hint, e.g. 'sk_a1b2c3d4'
  key_hash     text NOT NULL UNIQUE,        -- sha256 hex of the full secret
  scopes       text[] NOT NULL DEFAULT '{}',
  enabled      boolean NOT NULL DEFAULT true,
  last_used_at timestamptz,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_keys_tenant_idx ON api_keys (tenant_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON api_keys TO event_relay;
-- NOTE: intentionally NO ROW LEVEL SECURITY on api_keys (see header).
