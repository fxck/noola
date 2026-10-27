-- How long a workspace keeps its AI draft traces. NULL means the platform default of 90 days.
ALTER TABLE tenant_policies ADD COLUMN IF NOT EXISTS trace_retention_days integer;
-- Named and re-added, since every deploy re-runs this file.
ALTER TABLE tenant_policies DROP CONSTRAINT IF EXISTS tenant_policies_trace_retention_days_check;
ALTER TABLE tenant_policies DROP CONSTRAINT IF EXISTS tenant_policies_trace_retention_days_ck;
ALTER TABLE tenant_policies ADD CONSTRAINT tenant_policies_trace_retention_days_ck CHECK (trace_retention_days BETWEEN 1 AND 365);

-- The trace sweep finds every workspace, including those that never set a retention, and needs nothing but the id.
GRANT SELECT (id) ON tenants TO event_relay;

-- What the trace sweep deletes is counted here per UTC day, so reports that count drafts stay exact past the retention.
CREATE TABLE IF NOT EXISTS draft_trace_counts (
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  day       date NOT NULL,
  drafts    integer NOT NULL DEFAULT 0,
  -- Live drafts that never attached to a ticket: public questions the AI answered on its own.
  deflected integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON draft_trace_counts TO app_user;
ALTER TABLE draft_trace_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE draft_trace_counts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS draft_trace_counts_isolation ON draft_trace_counts;
CREATE POLICY draft_trace_counts_isolation ON draft_trace_counts
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
