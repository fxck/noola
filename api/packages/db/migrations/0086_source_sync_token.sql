-- Smart resync short-circuit: a per-source opaque "sync token" that captures the upstream's
-- current revision cheaply, so a re-crawl can skip the whole fetch when nothing moved. For a
-- GitHub source it's the branch head commit SHA (one cheap /commits call vs. the full tree + N
-- blob fetches); other kinds may later store an ETag / Last-Modified. NULL = no token recorded
-- yet (always do a full sync). Reset to NULL whenever a source's config changes (a new repo /
-- branch / path means the old token no longer describes what we'd fetch).
ALTER TABLE sources ADD COLUMN IF NOT EXISTS last_sync_token text;
