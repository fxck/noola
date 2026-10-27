-- Slice 05 — Email channel. Adds the recipient-address→tenant routing map.
-- Executed as superuser, idempotent.

-- email_routes: maps a tenant's inbound support address to the tenant that owns
-- it. Same design as discord_links (slice 02): DELIBERATELY OUTSIDE RLS. It is
-- read to RESOLVE the tenant from an inbound email's recipient, *before* any
-- tenant context exists — so it cannot sit behind a tenant policy. System-level
-- routing config, not tenant data. Read/written only by event_relay (BYPASSRLS);
-- app_user never touches it. The FK to tenants uses PG's internal RI path, which
-- bypasses the referenced table's RLS.
CREATE TABLE IF NOT EXISTS email_routes (
  address    text PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON email_routes TO event_relay;
-- NOTE: intentionally NO "ENABLE ROW LEVEL SECURITY" on email_routes (see above).
-- Demo routes are seeded by migrate.ts AFTER the demo tenants — email_routes.tenant_id
-- FKs to tenants, which don't exist until the JS seed step runs.
