-- Which detector version named a ticket's language. At startup the api re-detects tickets an older version named.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS locale_version smallint;
