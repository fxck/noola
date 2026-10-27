-- Wave 2 (outbound engine): marketing opt-out. A contact with unsubscribed_at set is
-- suppressed from EVERY broadcast channel at resolve time (email and chat alike) and
-- excluded from reach previews; transactional ticket replies are exempt. Set via the
-- public signed-token /u/:token lane (the email footer link + RFC 8058 one-click POST)
-- or by an agent through POST /contacts/:id/subscription.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS unsubscribed_at timestamptz;
