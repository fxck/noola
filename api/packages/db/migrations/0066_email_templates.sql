-- Wave 2 (outbound engine): per-tenant email template designer. A template is a named bag of
-- DESIGN TOKENS (colors, font, sizes, logo, footer, social links) that parameterizes the
-- react.email broadcast frame; the two built-ins ('branded', 'personal') live in code, custom
-- templates live here. broadcasts.template_id is text so it can hold a built-in slug OR a
-- custom row's uuid.
CREATE TABLE IF NOT EXISTS email_templates (
  tenant_id  uuid NOT NULL DEFAULT current_tenant() REFERENCES tenants (id) ON DELETE CASCADE,
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  tokens     jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON email_templates TO app_user;
ALTER TABLE email_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_templates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS email_templates_isolation ON email_templates;
CREATE POLICY email_templates_isolation ON email_templates
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS template_id text NOT NULL DEFAULT 'branded';
