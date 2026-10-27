-- WHO opted a contact out of marketing, next to WHEN (contacts.unsubscribed_at, 0065). The public
-- contacts API (contacts:write) mirrors an external system's consent flag, and must never silently
-- undo an opt-out the PERSON made (email link, one-click, preference center, spam complaint) or an
-- agent made by hand. So the API may re-subscribe without `force` only an opt-out it made itself
-- ('api'). Values: 'api' | 'contact' | 'agent' | 'import'. NULL while subscribed; a legacy opt-out
-- (pre-0120) stays NULL and reads as "not from the API" — the conservative default.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS unsubscribed_source text;
