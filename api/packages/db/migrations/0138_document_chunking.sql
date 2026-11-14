-- The splitter that made a document's passages. Documents from an older one are re-split at boot.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS chunking smallint NOT NULL DEFAULT 1;
