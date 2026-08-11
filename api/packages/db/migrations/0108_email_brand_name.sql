-- Per-tenant email brand name. The wordmark shown on the Branded/broadcast email frame used to be a
-- hardcoded "Noola" literal; it should be the tenant's own brand. Stored alongside the sender identity
-- (0104) since it's the same "how outbound email presents this workspace" concern. NULL / empty means
-- "fall back to the workspace name (tenants.name)", so an un-set tenant still shows a sensible brand.
ALTER TABLE email_sender_settings ADD COLUMN IF NOT EXISTS brand_name text;
