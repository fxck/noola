-- Companies gain an external id (Intercom's company `company_id`) — YOUR own identifier for the
-- account, distinct from Noola's internal uuid. Until now a company was keyed only by name, so a
-- rename forked the account and there was no stable handle to dedupe an identify against. With an
-- external_id, identify/dedup can match the SAME company across renames (external_id first, name
-- fallback), and the id is a first-class, visible field on the account.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS external_id text;

-- One company per external_id per tenant (when set). Empty/null external_id stays unconstrained, so
-- name-only companies (the legacy + manual path) are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS companies_external_id_uq
  ON companies (tenant_id, external_id)
  WHERE external_id IS NOT NULL AND external_id <> '';
