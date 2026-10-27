-- Wave 2 (outbound engine): block composer. A broadcast body can now be an ORDERED BLOCK
-- LIST (text/image/button/divider/spacer/html + merge tags) instead of one markdown string.
-- NULL blocks = the legacy markdown `body` path; when blocks are present, `body` holds a
-- markdown derivation for chat channels and plaintext fallback.
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS blocks jsonb;
