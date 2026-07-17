-- KB Collections: a tenant-scoped taxonomy for grouping KB articles into
-- collections ("folders"). Articles reference a collection via
-- kb_articles.collection_id (nullable — NULL = uncategorized). Same FORCE-RLS
-- isolation as the rest of the schema. Idempotent (re-run every deploy).

CREATE TABLE IF NOT EXISTS kb_collections (
  tenant_id   uuid NOT NULL,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  color       text NOT NULL DEFAULT '',
  position    int  NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS kb_collections_order_idx ON kb_collections (tenant_id, position, created_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON kb_collections TO app_user;
GRANT SELECT ON kb_collections TO event_relay;

ALTER TABLE kb_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_collections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kb_collections_isolation ON kb_collections;
CREATE POLICY kb_collections_isolation ON kb_collections
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

-- Link articles to a collection (nullable; ON DELETE SET NULL keeps the article when a
-- collection is removed — it just falls back to uncategorized). The composite FK carries
-- tenant_id so an article can never point at another tenant's collection.
ALTER TABLE kb_articles ADD COLUMN IF NOT EXISTS collection_id uuid;
CREATE INDEX IF NOT EXISTS kb_articles_collection_idx ON kb_articles (tenant_id, collection_id);
-- ON DELETE SET NULL (collection_id): the column-list form (Postgres 15+) nulls ONLY
-- collection_id when a collection is deleted. Plain SET NULL on a composite FK would null
-- every referencing column — including the NOT NULL tenant_id — and fail. DROP+ADD keeps
-- the migration idempotent (re-runs update the definition in place).
ALTER TABLE kb_articles DROP CONSTRAINT IF EXISTS kb_articles_collection_fk;
ALTER TABLE kb_articles
  ADD CONSTRAINT kb_articles_collection_fk
  FOREIGN KEY (tenant_id, collection_id)
  REFERENCES kb_collections (tenant_id, id) ON DELETE SET NULL (collection_id);
