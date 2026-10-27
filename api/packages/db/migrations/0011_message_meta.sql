-- Slice 12 — message meta. Attach per-reply generation stats to the message row so
-- the UI can render "N tokens / ~$X / K sources / model M / T ms" INLINE on the
-- message, without a second round-trip to the decision/trace stores.
--
-- Nullable, no default: only AI auto-sends (and future assist accepts) carry a meta
-- blob; ordinary human/customer messages leave it NULL. jsonb so the shape can evolve
-- without a schema change. No separate GRANT is needed — a new column inherits the
-- table-level grants already held by app_user (see 0000_init) and is covered by the
-- existing FORCE-RLS policy on messages.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS meta jsonb;
