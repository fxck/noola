-- Slice — Ask-AI public widget. Adds the public-key→tenant routing map for the
-- embeddable widget's POST /public/ask lane. Executed as superuser, idempotent.

-- widget_keys: maps a PUBLIC widget key (embedded in a customer's site — NOT a secret)
-- to the tenant that owns it, plus an optional domain allowlist. Same design as
-- discord_links / email_routes (slices 02/05): DELIBERATELY OUTSIDE RLS — it is read to
-- RESOLVE the tenant from an inbound public request *before* any tenant context exists,
-- so it cannot sit behind a tenant policy. System-level routing config, not tenant data.
-- Read/written only by event_relay (the BYPASSRLS cross-tenant role); app_user never
-- touches it. The FK to tenants uses PG's internal RI path, which bypasses the
-- referenced table's RLS. The real per-tenant access control for management endpoints is
-- an explicit tenant_id predicate in every query (server-authoritative session tenant).
CREATE TABLE IF NOT EXISTS widget_keys (
  public_key      text PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  label           text,
  allowed_domains text[] NOT NULL DEFAULT '{}',   -- empty = any origin (dev/testing)
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS widget_keys_tenant_idx ON widget_keys (tenant_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON widget_keys TO event_relay;
-- NOTE: intentionally NO "ENABLE ROW LEVEL SECURITY" on widget_keys (see above).
-- Demo key is seeded by migrate.ts AFTER the demo tenants (FK to tenants).
