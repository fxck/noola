-- Avatar images for people (contacts) and team members (the app `users` roster). The image
-- bytes live in object-storage; these columns hold the API-relative serve path
-- (/uploads/avatar/<key>). Nullable — absent means the UI falls back to initials.

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS avatar_url text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url text;
