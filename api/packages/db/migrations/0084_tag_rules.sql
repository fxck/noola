-- Auto-tagging → a seeded, forkable managed flow (STUDIO-SEEDED-FLOWS.md #1).
-- The deterministic keyword→tag mapping that used to live frozen in autotag.ts (KEYWORD_TAGS /
-- RISK_TO_TAG) becomes a per-tenant CONFIG table, projected into managed `ticket.created`
-- automations (managed_by='autotag') by seedflows.projectAutotag — so tagging is transparent in
-- Studio, tenant-editable, and forkable via POST /automations/:id/graduate. The optional hosted-
-- model tagging is a single managed automation gated by tag_settings.ai_enabled.

-- One keyword→tag rule. `keywords` is a flat list; a match on the subject OR body (substring,
-- case-insensitive) appends `tag`. The projection turns each enabled row into one automation.
CREATE TABLE IF NOT EXISTS tag_rules (
  tenant_id  uuid NOT NULL DEFAULT current_tenant(),
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  tag        text NOT NULL,
  keywords   text[] NOT NULL DEFAULT '{}',
  enabled    boolean NOT NULL DEFAULT true,
  position   integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
ALTER TABLE tag_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE tag_rules FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY tag_rules_iso ON tag_rules USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON tag_rules TO app_user;
GRANT SELECT ON tag_rules TO event_relay;

-- Per-tenant tag config. A row's PRESENCE marks "defaults have been installed" (ensureTagDefaults
-- seeds rules only on the first insert), so a tenant who deletes every rule stays empty rather than
-- getting the defaults re-added. `ai_enabled` toggles the hosted-model tagging automation.
CREATE TABLE IF NOT EXISTS tag_settings (
  tenant_id  uuid NOT NULL DEFAULT current_tenant() PRIMARY KEY,
  ai_enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tag_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tag_settings FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY tag_settings_iso ON tag_settings USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON tag_settings TO app_user;
GRANT SELECT ON tag_settings TO event_relay;

-- Backfill enumerates every tenant to install defaults + project (preserving always-on tagging for
-- existing tenants); event_relay reads the org list on the BYPASSRLS relay pool.
GRANT SELECT ON "organization" TO event_relay;
