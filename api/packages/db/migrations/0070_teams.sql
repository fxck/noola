-- Wave 3 item 11 — Teams: named agent groups that act as inbox lanes, assignment targets,
-- and routing pools. tickets.team_id is the lane a conversation belongs to, orthogonal to
-- assignee_id (a ticket can sit with a team before any person picks it up). Tenant-isolated
-- via FORCE RLS like every app table; composite FKs carry tenant_id so cross-tenant
-- membership/assignment is impossible by key.

CREATE TABLE IF NOT EXISTS teams (
  tenant_id  uuid NOT NULL,
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  emoji      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS teams_name_uq ON teams (tenant_id, lower(name));

GRANT SELECT, INSERT, UPDATE, DELETE ON teams TO app_user;
GRANT SELECT ON teams TO event_relay;
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS teams_isolation ON teams;
CREATE POLICY teams_isolation ON teams
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

CREATE TABLE IF NOT EXISTS team_members (
  tenant_id  uuid NOT NULL,
  team_id    uuid NOT NULL,
  user_id    uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, team_id, user_id),
  FOREIGN KEY (tenant_id, team_id) REFERENCES teams (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS team_members_user_idx ON team_members (tenant_id, user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON team_members TO app_user;
GRANT SELECT ON team_members TO event_relay;
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS team_members_isolation ON team_members;
CREATE POLICY team_members_isolation ON team_members
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

-- The team lane on a conversation. SET NULL must name the column (PG15+ form) — a bare
-- composite SET NULL would null tenant_id too (the 0062 lesson).
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS team_id uuid;
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_team_fk;
ALTER TABLE tickets ADD CONSTRAINT tickets_team_fk
  FOREIGN KEY (tenant_id, team_id) REFERENCES teams (tenant_id, id)
  ON DELETE SET NULL (team_id);
CREATE INDEX IF NOT EXISTS tickets_team_open_idx ON tickets (tenant_id, team_id) WHERE status = 'open';

-- Routing rules can target a team: the pool becomes the team's members and the ticket lands
-- in the team's lane. NULL = the classic agent-pool rule.
ALTER TABLE routing_rules ADD COLUMN IF NOT EXISTS team_id uuid;
ALTER TABLE routing_rules DROP CONSTRAINT IF EXISTS routing_rules_team_fk;
ALTER TABLE routing_rules ADD CONSTRAINT routing_rules_team_fk
  FOREIGN KEY (tenant_id, team_id) REFERENCES teams (tenant_id, id)
  ON DELETE SET NULL (team_id);
