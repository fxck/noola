-- Slice 08 — Knowledge Base. Tenant-scoped articles: the substrate for KB search
-- now and KB Copilot / RAG later. Same FORCE-RLS discipline as every tenant table
-- (isolation is the central invariant), composite PK carrying tenant_id.

CREATE TABLE IF NOT EXISTS kb_articles (
  tenant_id  uuid NOT NULL,
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  title      text NOT NULL,
  body       text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON kb_articles TO app_user;
-- event_relay (BYPASSRLS) reads across tenants for the search backfill (like tickets).
GRANT SELECT ON kb_articles TO event_relay;

ALTER TABLE kb_articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_articles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kb_articles_isolation ON kb_articles;
CREATE POLICY kb_articles_isolation ON kb_articles
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
