-- Slice 14 — Live sources (connectors). A tenant registers an external source (a docs
-- URL / sitemap now; GitHub / Discord later) and a sync engine fetches it, converts to
-- text, and ingests it through the existing document pipeline tagged by source_id — so
-- it becomes citable in retrieval. Re-sync replaces the source's docs (delete-by-source
-- then re-ingest). Per-kind connector registry lives in the app; this is just the
-- registry table + the tag column's index. Same FORCE-RLS discipline as every tenant table.

CREATE TABLE IF NOT EXISTS sources (
  tenant_id      uuid NOT NULL,
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  kind           text NOT NULL,                   -- url | github | discord
  label          text NOT NULL DEFAULT '',
  config         jsonb NOT NULL DEFAULT '{}',      -- e.g. { "url": "https://docs..." }
  status         text NOT NULL DEFAULT 'pending',  -- pending | syncing | ok | error
  last_error     text,
  doc_count      int  NOT NULL DEFAULT 0,
  last_synced_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT sources_kind_ck CHECK (kind IN ('url','github','discord')),
  CONSTRAINT sources_status_ck CHECK (status IN ('pending','syncing','ok','error'))
);

-- Tag each document with the source it was ingested from (null for direct uploads).
-- Add it idempotently HERE, before the index, so a from-scratch migrate has the column
-- (older databases added it earlier in the ingest slice — this is a no-op there). Then
-- index it so delete-by-source and per-source listing are cheap on re-sync.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_id uuid;
CREATE INDEX IF NOT EXISTS documents_source_idx ON documents (tenant_id, source_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON sources TO app_user;
-- event_relay (BYPASSRLS) reads for the outbox relay / future backfill.
GRANT SELECT ON sources TO event_relay;

ALTER TABLE sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE sources FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sources_isolation ON sources;
CREATE POLICY sources_isolation ON sources
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
