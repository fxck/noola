-- Incremental source resync: per-document content hash + stable connector key, so a re-crawl only
-- re-embeds/re-indexes the units that actually CHANGED (the cost is embedding+indexing, not the
-- fetch) instead of the old delete-all-then-reingest-all. `source_key` is the connector unit's
-- stable id (page URL / repo file path / discord batch key); `content_hash` is sha256 of its
-- content. Both null for hand-uploaded documents.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_key   text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS content_hash text;

-- The diff loads existing (source_key, content_hash) per source — index the lookup.
CREATE INDEX IF NOT EXISTS documents_source_key_idx ON documents (tenant_id, source_id, source_key);
