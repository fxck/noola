-- Slice 07 — search backfill grants. reindexAllTickets runs at boot as the
-- event_relay role (BYPASSRLS, the trusted system relay) to index EVERY tenant's
-- tickets into Typesense, so it needs read on the ticket + message tables.
--
-- Query-time isolation is unchanged: every Typesense doc carries its tenant_id
-- and every search filters by it. This only lets the system role READ across
-- tenants to *build* the index — exactly as it already reads the cross-tenant
-- outbox. app_user (the RLS-bound request role) is untouched.
GRANT SELECT ON tickets, messages TO event_relay;
