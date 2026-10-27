-- 0095: per-widget-key identity-verification secret (Intercom-style user_hash HMAC).
--
-- The host site computes  user_hash = HMAC_SHA256(identity_secret, user_id || email)  on its
-- OWN server and passes it via Noola('boot', { user_hash }). The api recomputes the HMAC with
-- this per-key secret and constant-time compares before trusting an identified visitor or
-- returning that person's server-side conversation history. The secret NEVER reaches the
-- browser (it is absent from /public/config); only the authed dashboard can read it.
--
-- widget_keys sits OUTSIDE RLS (read only by the BYPASSRLS event_relay role), so the existing
-- GRANT on the table already covers this column — no new grant needed.
ALTER TABLE widget_keys ADD COLUMN IF NOT EXISTS identity_secret text;

-- Backfill a strong secret (64 hex chars) for every pre-existing key so verification can be
-- switched on without a manual rotate. sha256()/gen_random_uuid() are core in PG 13+ (no
-- pgcrypto). New keys get a crypto.randomBytes(32) secret minted by the app on create.
UPDATE widget_keys
   SET identity_secret = encode(
         sha256((gen_random_uuid()::text || public_key || clock_timestamp()::text)::bytea), 'hex')
 WHERE identity_secret IS NULL;
