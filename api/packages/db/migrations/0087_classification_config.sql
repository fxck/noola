-- STUDIO-SEEDED-FLOWS #3+#4: three hardcoded classifier maps → per-tenant R2 config tables (forms,
-- not flows). Each keeps the built-in defaults as its seed. topic_rules + slack_reaction_map are full
-- config (seeded on first touch, tenant owns them); risk_keywords is ADDITIVE — the built-in
-- RISK_RULES in model.ts always apply and can't be removed, tenants only ADD patterns (tighten-only).
-- classification_settings is the per-tenant "defaults installed" marker (so a tenant who clears a
-- table stays cleared instead of getting the defaults re-seeded), mirroring tag_settings.

-- Primary-topic keyword rules (topics.ts TOPIC_RULES). Ordered by position; first ENABLED rule with a
-- matching keyword (substring, case-insensitive, subject OR body) wins → its topic. The deterministic
-- floor under the hosted-model topic classifier.
CREATE TABLE IF NOT EXISTS topic_rules (
  tenant_id  uuid NOT NULL DEFAULT current_tenant(),
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  topic      text NOT NULL,
  keywords   text[] NOT NULL DEFAULT '{}',
  enabled    boolean NOT NULL DEFAULT true,
  position   integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
ALTER TABLE topic_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE topic_rules FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY topic_rules_iso ON topic_rules USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON topic_rules TO app_user;

-- Slack emoji→triage-action map (slack-triage.ts REACTION_MAP). A flat mapping: reacting with an
-- emoji on any message in a bound channel triages that channel's ticket. `action` is a SlackActionKind.
CREATE TABLE IF NOT EXISTS slack_reaction_map (
  tenant_id  uuid NOT NULL DEFAULT current_tenant(),
  emoji      text NOT NULL,
  action     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, emoji)
);
ALTER TABLE slack_reaction_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE slack_reaction_map FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY slack_reaction_map_iso ON slack_reaction_map USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON slack_reaction_map TO app_user;

-- ADDITIVE risk keywords (model.ts classifyRisk). The built-in RISK_RULES stay in code and ALWAYS
-- apply — this table only ADDS tenant patterns on top (a match appends `risk_tag`), so a tenant can
-- tighten the autoreply guardrail but never loosen it. No defaults seeded (empty = built-ins only).
CREATE TABLE IF NOT EXISTS risk_keywords (
  tenant_id  uuid NOT NULL DEFAULT current_tenant(),
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  risk_tag   text NOT NULL,
  keywords   text[] NOT NULL DEFAULT '{}',
  enabled    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
ALTER TABLE risk_keywords ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_keywords FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY risk_keywords_iso ON risk_keywords USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON risk_keywords TO app_user;

-- Per-tenant "classification defaults installed" marker (mirrors tag_settings): its PRESENCE means
-- ensureClassificationDefaults already seeded topic_rules + slack_reaction_map, so clearing a table
-- stays cleared. risk_keywords is additive and never auto-seeded.
CREATE TABLE IF NOT EXISTS classification_settings (
  tenant_id  uuid NOT NULL DEFAULT current_tenant() PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE classification_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE classification_settings FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY classification_settings_iso ON classification_settings USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON classification_settings TO app_user;
