-- How the AI searches the docs: whether a model writes the search query, what the product is, and an optional replacement prompt.
CREATE TABLE IF NOT EXISTS docs_search_settings (
  tenant_id  uuid PRIMARY KEY DEFAULT current_tenant() REFERENCES tenants (id) ON DELETE CASCADE,
  rewrite    boolean NOT NULL DEFAULT true,
  product    text NOT NULL DEFAULT '',
  prompt     text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON docs_search_settings TO app_user;
ALTER TABLE docs_search_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE docs_search_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS docs_search_settings_isolation ON docs_search_settings;
CREATE POLICY docs_search_settings_isolation ON docs_search_settings
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
