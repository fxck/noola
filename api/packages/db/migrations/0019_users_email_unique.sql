-- Phase-1 auth hardening. Login resolves email → user → tenant BEFORE any tenant
-- context exists (findUserByEmail runs as event_relay / BYPASSRLS). With no uniqueness
-- on email, the same address in two tenants makes that lookup's LIMIT 1 pick an arbitrary
-- account — an ambiguous, tenant-confusing login. Enforce one account per email globally.
-- Superuser, idempotent (unique index; email is NOT NULL so there are no NULL rows).
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (email);
