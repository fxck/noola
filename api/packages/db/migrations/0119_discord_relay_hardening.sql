-- 0119_discord_relay_hardening.sql
-- Stop the Discord relay outbox from delivering the same write more than once.
--
-- Observed in prod (ticket e525783c…, 2026-09-17): one relayed message was re-posted into its mirror
-- thread on every attempt until the row dead-lettered after 10 attempts, all "deliver deadline
-- exceeded". The post itself landed each time; the deliverer then awaited a forum tag/archive sync
-- that sat behind Discord's thread-edit rate limit past the 20s deadline, so the drainer counted a
-- delivered message as failed and posted it again.
--
-- The code fix separates "the write landed" from any follow-up sync and sends every post with a
-- Discord nonce (enforce_nonce) so a retry of a write that landed late is collapsed by Discord itself.
-- This migration adds the fencing token the drainer needs so a claim can't be delivered twice:
--
--  • lease_token — set fresh on every claim. The lease extension taken right before the Discord call,
--    and every finalize (delivered / backoff / failed), match on it. A drainer whose lease expired
--    (a slow batch, or the second api container) can then neither deliver the row nor overwrite the
--    outcome recorded by the drainer that took it over.

ALTER TABLE discord_relay_outbox ADD COLUMN IF NOT EXISTS lease_token uuid;
