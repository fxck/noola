import pg from "pg";

const { Pool } = pg;

const base = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME,
};

/** Request-path pool — RLS-bound role. Every query MUST run inside withTenant(). */
export const appPool = new Pool({
  ...base,
  user: process.env.APP_DB_USER ?? "app_user",
  password: process.env.APP_DB_PASSWORD,
  max: 10,
});

/** Outbox-drainer pool — BYPASSRLS role, sees across tenants. */
export const relayPool = new Pool({
  ...base,
  user: process.env.RELAY_DB_USER ?? "event_relay",
  password: process.env.RELAY_DB_PASSWORD,
  max: 2,
});

/** Identity-surface pool — the least-privilege `auth_user` role (better-auth's DB
 *  principal). NO BYPASSRLS; granted DML only on the RLS-exempt better-auth tables (0021),
 *  never the app tables. Nothing else in the app connects as it. */
export const authPool = new Pool({
  ...base,
  user: process.env.AUTH_DB_USER ?? "auth_user",
  password: process.env.AUTH_DB_PASSWORD,
  max: 5,
});

/**
 * Run `fn` in a tenant-scoped transaction on the app pool.
 * set_config(..., true) is transaction-local (like SET LOCAL) and resets to ''
 * when the pooled backend is reused — so RLS default-denies the next caller
 * that forgets to scope. This is the ONLY sanctioned request-path DB entry.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const c = await appPool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
