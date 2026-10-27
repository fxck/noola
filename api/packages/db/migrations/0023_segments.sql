-- Saved Segments: named, reusable filter definitions — the contacts filter-builder
-- conditions plus the free-text query — persisted per tenant so a filtered view can be
-- saved and re-applied. `resource` scopes a segment to a surface ('contacts' for now,
-- room for tickets/companies later); `definition` is the JSON the surface re-applies
-- ({ q?, filters: ContactFilterCondition[], sort? }). Same FORCE-RLS isolation.

CREATE TABLE IF NOT EXISTS segments (
  tenant_id  uuid NOT NULL,
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  resource   text NOT NULL DEFAULT 'contacts',
  definition jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS segments_resource_idx ON segments (tenant_id, resource, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON segments TO app_user;
GRANT SELECT ON segments TO event_relay;

ALTER TABLE segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE segments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS segments_isolation ON segments;
CREATE POLICY segments_isolation ON segments
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
