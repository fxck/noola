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

/** Cross-tenant pool — BYPASSRLS role. Started life as just the outbox drainer, but it's now the
 *  shared pre-tenant / cross-tenant READ pool too: lookups keyed by something other than a tenant
 *  (guild_id, email route address, api key, sla policies, …) run here before the tenant is known.
 *  max:2 was sized for the lone drainer and is far too tight for that fan-in — a couple of concurrent
 *  relay reads (or a slow drain) exhausted it and blocked every other relay query. Give it headroom. */
export const relayPool = new Pool({
  ...base,
  user: process.env.RELAY_DB_USER ?? "event_relay",
  password: process.env.RELAY_DB_PASSWORD,
  max: 8,
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

// A pooled client can emit 'error' ASYNCHRONOUSLY while sitting idle in the pool — the
// backend goes away out from under us (Postgres restart, network blip, admin
// pg_terminate_backend, idle_in_transaction_session_timeout). node-postgres re-emits that
// on the Pool; with no 'error' listener it propagates as an uncaught exception and the whole
// process exits (seen in prod: a pg Client dumped to stdout followed by `node server.mjs => 1`,
// taking down every in-flight request). Listening here keeps the process alive — pg has
// already removed the dead client from the pool, so the next connect() just makes a fresh one.
for (const [name, pool] of [
  ["app", appPool],
  ["relay", relayPool],
  ["auth", authPool],
] as const) {
  pool.on("error", (err) => {
    console.error(
      `[db] idle client error on ${name}Pool (dropped & evicted, pool will reconnect):`,
      err instanceof Error ? err.message : err,
    );
  });
}

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
