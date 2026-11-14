-- When the person joined the company, as the system of record reports it. The oldest membership becomes the primary.
ALTER TABLE contact_companies ADD COLUMN IF NOT EXISTS joined_at timestamptz;
-- A person chose the contact's primary company, so a sync keeps it.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS primary_company_chosen boolean NOT NULL DEFAULT false;
