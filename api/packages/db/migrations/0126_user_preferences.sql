-- Per-person settings that only change how Noola looks or behaves for that person, e.g. GIF previews.
-- One JSON document per member, validated by the api (UserPreferences in @repo/contracts), so a new
-- setting needs no migration. A setting the server has to query by gets a real column instead.
CREATE TABLE IF NOT EXISTS user_preferences (
  tenant_id  uuid NOT NULL,
  user_id    uuid NOT NULL,
  prefs      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);

GRANT SELECT, INSERT, UPDATE, DELETE ON user_preferences TO app_user;
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preferences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_preferences_isolation ON user_preferences;
CREATE POLICY user_preferences_isolation ON user_preferences
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
