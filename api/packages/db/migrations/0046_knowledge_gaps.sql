-- Content-gap detection (the Inkeep/Kapa knowledge-loop). Every RAG answer path funnels through
-- copilot.suggestForQuery, which computes a retrieval summary (topScore, agreement) + confidence.
-- When retrieval is WEAK (no corroborating source / low top score), the question was one the KB
-- couldn't answer — a content gap. We record it here, grouped by a normalized question key so the
-- same unanswered question CLUSTERS (occurrences++) instead of spamming rows. The Sources page
-- surfaces the worklist so gaps route back into KB authoring; resolving a gap can link the article
-- that closed it. Same FORCE-RLS isolation as the other tenant tables.
CREATE TABLE IF NOT EXISTS knowledge_gaps (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL DEFAULT current_tenant() REFERENCES tenants (id) ON DELETE CASCADE,
  question            text NOT NULL,
  normalized          text NOT NULL,
  confidence          real,
  top_score           real,
  agreement           integer NOT NULL DEFAULT 0,
  source              text NOT NULL DEFAULT 'live',
  ticket_id           uuid,
  occurrences         integer NOT NULL DEFAULT 1,
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolved_article_id uuid,
  first_seen          timestamptz NOT NULL DEFAULT now(),
  last_seen           timestamptz NOT NULL DEFAULT now(),
  -- One row per (tenant, normalized question) — the upsert increments occurrences on a repeat.
  UNIQUE (tenant_id, normalized)
);
CREATE INDEX IF NOT EXISTS knowledge_gaps_worklist_idx ON knowledge_gaps (tenant_id, status, occurrences DESC, last_seen DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_gaps TO app_user;
ALTER TABLE knowledge_gaps ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_gaps FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_gaps_isolation ON knowledge_gaps;
CREATE POLICY knowledge_gaps_isolation ON knowledge_gaps
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
