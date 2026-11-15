-- Knowledge gaps come from a model review of each closed conversation.
-- A table that still has the `normalized` column holds raw customer messages, so it is rebuilt once.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'knowledge_gaps' AND column_name = 'normalized') THEN
    DROP TABLE knowledge_gaps;
  END IF;
END $$;

-- A gap is one reusable question that the docs or the help articles miss, merged across conversations.
-- 0046 re-runs before this file and indexes (tenant_id, status, occurrences, last_seen), so those columns stay.
CREATE TABLE IF NOT EXISTS knowledge_gaps (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL DEFAULT current_tenant() REFERENCES tenants (id) ON DELETE CASCADE,
  question            text NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('docs_missing', 'docs_unclear', 'support_knowledge')),
  page_url            text,
  collection          text,
  occurrences         integer NOT NULL DEFAULT 1,
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolved_article_id uuid,
  first_seen          timestamptz NOT NULL DEFAULT now(),
  last_seen           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_gaps_worklist_idx ON knowledge_gaps (tenant_id, status, occurrences DESC, last_seen DESC);

-- Each conversation that raised a gap, with what the review found in it.
CREATE TABLE IF NOT EXISTS knowledge_gap_questions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL DEFAULT current_tenant() REFERENCES tenants (id) ON DELETE CASCADE,
  gap_id      uuid NOT NULL REFERENCES knowledge_gaps (id) ON DELETE CASCADE,
  ticket_id   uuid NOT NULL,
  question    text NOT NULL,
  kind        text NOT NULL,
  answer      text,
  page_url    text,
  article_id  uuid,
  suggestion  text,
  title       text,
  collection  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES tickets (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS knowledge_gap_questions_gap_idx ON knowledge_gap_questions (gap_id, created_at);
CREATE INDEX IF NOT EXISTS knowledge_gap_questions_ticket_idx ON knowledge_gap_questions (tenant_id, ticket_id);

-- One review per closed conversation. A conversation that closes again after reviewed_at is reviewed again.
-- questions holds every reviewed question, the answered and not reusable ones too, for the counts.
CREATE TABLE IF NOT EXISTS gap_reviews (
  tenant_id     uuid NOT NULL DEFAULT current_tenant() REFERENCES tenants (id) ON DELETE CASCADE,
  ticket_id     uuid NOT NULL,
  conversation  text CHECK (conversation IN ('questions', 'account_issue', 'feedback', 'no_question')),
  questions     jsonb NOT NULL DEFAULT '[]'::jsonb,
  error         text,
  attempts      integer NOT NULL DEFAULT 0,
  failures      integer NOT NULL DEFAULT 0,
  reviewed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, ticket_id),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES tickets (tenant_id, id) ON DELETE CASCADE
);

-- enabled: the workspace reviews its closed conversations with its own model.
CREATE TABLE IF NOT EXISTS gap_settings (
  tenant_id   uuid PRIMARY KEY DEFAULT current_tenant() REFERENCES tenants (id) ON DELETE CASCADE,
  enabled     boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['knowledge_gaps', 'knowledge_gap_questions', 'gap_reviews', 'gap_settings'] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_isolation', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t || '_isolation', t);
  END LOOP;
END $$;

-- The sweep finds the conversations to review across workspaces.
GRANT SELECT ON gap_settings, gap_reviews TO event_relay;
