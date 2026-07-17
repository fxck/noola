-- Widget personalization — per-key messenger config (accent, greeting, launcher position,
-- enabled tabs). Read by GET /public/config so the embedded widget reflects the admin's
-- Settings → Messenger personalization; managed via PATCH /widget-keys/:key. Same
-- OUTSIDE-RLS discipline as the rest of widget_keys (see 0020): resolved pre-tenant on the
-- BYPASSRLS relay, guarded by an explicit tenant_id predicate on the management path.
-- Idempotent; superuser.
ALTER TABLE widget_keys ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}';
