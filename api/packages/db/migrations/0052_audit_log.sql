-- Tamper-evident audit log — an append-only, per-tenant HMAC hash-chain. Each row's `hash` is
-- HMAC(secret, prev_hash || canonical(row)); `prev_hash` links to the previous row's hash, so any
-- retroactive edit/delete/reorder breaks every subsequent hash and the chain verify fails. `seq` is
-- a per-tenant monotonic counter (assigned under an advisory lock at append time) that both orders
-- the chain and makes a silently-removed row detectable as a gap. The secret lives in app env, not
-- the DB, so an actor with only DB access cannot recompute a forged chain.
CREATE TABLE IF NOT EXISTS audit_log (
  tenant_id   uuid NOT NULL DEFAULT current_tenant() REFERENCES tenants (id) ON DELETE CASCADE,
  seq         bigint NOT NULL,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  actor_id    text,
  actor_name  text NOT NULL DEFAULT '',
  action      text NOT NULL,
  entity_type text NOT NULL DEFAULT '',
  entity_id   text,
  meta        jsonb NOT NULL DEFAULT '{}',
  prev_hash   text NOT NULL DEFAULT '',
  hash        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, seq)
);
CREATE INDEX IF NOT EXISTS audit_log_recent_idx ON audit_log (tenant_id, seq DESC);
CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON audit_log (tenant_id, entity_type, entity_id);

GRANT SELECT, INSERT ON audit_log TO app_user;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_log_isolation ON audit_log;
CREATE POLICY audit_log_isolation ON audit_log
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
