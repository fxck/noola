-- Deferred-tails sweep: (a) OOO end date — out_of_office auto-expires at ooo_until (pool
-- eligibility checks the pair; a tenant-scoped read-repair clears expired flags so UI badges
-- return without a cross-tenant writer); (b) broadcast day/time send window — the scheduler
-- only fires scheduled sends / continuous ticks inside it ("Send now" bypasses; NULLs = no
-- window); (c) one email template per tenant may be flagged as the ticket-reply frame.

ALTER TABLE users ADD COLUMN IF NOT EXISTS ooo_until timestamptz;

-- ISO weekdays 1–7; minutes-of-day 0–1439 in the tenant's chosen offset (same convention as
-- sla_policies business hours). All NULL = send anytime.
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS window_days int[];
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS window_start_min int;
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS window_end_min int;
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS window_tz_offset_min int;

ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS use_for_replies boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS email_templates_reply_uq
  ON email_templates (tenant_id) WHERE use_for_replies;
