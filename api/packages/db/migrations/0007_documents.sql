-- Slice 09 — Document ingestion. Uploaded documents are stored in object-storage,
-- their text extracted and split into chunks; chunks are the retrieval unit (keyword
-- now via Typesense, vector later behind the EmbeddingDriver seam). Same FORCE-RLS
-- discipline; chunks carry tenant_id so retrieval can never cross tenants.

CREATE TABLE IF NOT EXISTS documents (
  tenant_id    uuid NOT NULL,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  filename     text NOT NULL,
  content_type text NOT NULL,
  storage_key  text NOT NULL,           -- object-storage key of the raw upload
  char_count   int  NOT NULL DEFAULT 0,
  chunk_count  int  NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'indexed', -- indexed | failed
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS document_chunks (
  tenant_id   uuid NOT NULL,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL,
  chunk_index int  NOT NULL,
  text        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  -- composite FK carries tenant_id so a chunk can never point at another tenant's doc.
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS document_chunks_doc_idx ON document_chunks (tenant_id, document_id, chunk_index);

GRANT SELECT, INSERT, UPDATE, DELETE ON documents, document_chunks TO app_user;
-- event_relay (BYPASSRLS) reads across tenants for the search backfill.
GRANT SELECT ON documents, document_chunks TO event_relay;

ALTER TABLE documents        ENABLE ROW LEVEL SECURITY; ALTER TABLE documents        FORCE ROW LEVEL SECURITY;
ALTER TABLE document_chunks  ENABLE ROW LEVEL SECURITY; ALTER TABLE document_chunks  FORCE ROW LEVEL SECURITY;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['documents','document_chunks'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_isolation ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())',
      t, t);
  END LOOP;
END $$;
