import pg from "pg";
import { appPool, relayPool, withTenant } from "../src/client.js";

// The un-skippable gate: proves FORCE-RLS tenant isolation on the live managed
// Postgres, through the exact request-path pool the app uses. Exit 1 on any fail.

const A = "11111111-1111-1111-1111-111111111111"; // Acme
const B = "22222222-2222-2222-2222-222222222222"; // Globex

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.error(`  FAIL  ${name}`);
  }
}

async function main() {
  const superPool = new pg.Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_SUPER_USER,
    password: process.env.DB_SUPER_PASSWORD,
    max: 1,
  });

  const clean = async () => {
    await superPool.query("DELETE FROM messages WHERE body LIKE 'ISOTEST%'");
    await superPool.query("DELETE FROM tickets WHERE subject LIKE 'ISOTEST%'");
    await superPool.query("DELETE FROM outbox WHERE event_type = 'isotest'");
  };
  await clean();

  // A — default-deny + the nullif guard
  {
    const c = await appPool.connect();
    try {
      const t = await c.query("SELECT current_tenant() AS ct");
      check("current_tenant() is NULL on a fresh backend (no GUC)", t.rows[0].ct === null);

      // empty-string GUC (the pooled-reuse reset value) must NOT cast-error
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', '', true)");
      const t2 = await c.query("SELECT current_tenant() AS ct");
      check("current_tenant() is NULL when GUC='' (nullif guard, no cast error)", t2.rows[0].ct === null);
      await c.query("COMMIT");

      const r = await c.query("SELECT count(*)::int AS n FROM tickets");
      check("app_user sees 0 tickets without a tenant GUC (default-deny)", r.rows[0].n === 0);
    } finally {
      c.release();
    }
  }

  // B — write + read under tenant A
  let aTicketId = "";
  await withTenant(A, async (c) => {
    const r = await c.query(
      "INSERT INTO tickets (tenant_id, subject) VALUES (current_tenant(), 'ISOTEST-A') RETURNING id",
    );
    aTicketId = r.rows[0].id;
    await c.query(
      "INSERT INTO messages (tenant_id, ticket_id, body, idempotency_key) VALUES (current_tenant(), $1, 'ISOTEST-A msg', 'iso-a-1')",
      [aTicketId],
    );
    await c.query(
      "INSERT INTO outbox (tenant_id, event_type, subject, payload) VALUES (current_tenant(), 'isotest', 'noola.events.' || current_tenant(), '{}'::jsonb)",
    );
    const n = await c.query("SELECT count(*)::int AS n FROM tickets WHERE subject LIKE 'ISOTEST%'");
    check("tenant A sees its own ISOTEST ticket", n.rows[0].n === 1);
  });

  // C/D — tenant B is blind to A, and cannot mutate A's row
  await withTenant(B, async (c) => {
    const n = await c.query("SELECT count(*)::int AS n FROM tickets WHERE subject LIKE 'ISOTEST%'");
    check("tenant B cannot SELECT tenant A's ticket (cross-tenant read blocked)", n.rows[0].n === 0);

    const u = await c.query("UPDATE tickets SET subject = 'HACKED' WHERE id = $1", [aTicketId]);
    check("tenant B cross-tenant UPDATE affects 0 rows", u.rowCount === 0);
  });

  // E — no leak across pooled backend reuse
  {
    const c = await appPool.connect();
    try {
      const r = await c.query("SELECT count(*)::int AS n FROM tickets");
      check("no leak: reused app backend sees 0 tickets without a GUC", r.rows[0].n === 0);
    } finally {
      c.release();
    }
  }

  // F — event_relay bypasses RLS to drain cross-tenant
  {
    const r = await relayPool.query(
      "SELECT count(*)::int AS n FROM outbox WHERE event_type = 'isotest'",
    );
    check("event_relay (BYPASSRLS) sees the outbox row across tenants", r.rows[0].n >= 1);
  }

  // G — idempotency dedupe
  {
    let rejected = false;
    try {
      await withTenant(A, async (c) => {
        await c.query(
          "INSERT INTO messages (tenant_id, ticket_id, body, idempotency_key) VALUES (current_tenant(), $1, 'ISOTEST-A dup', 'iso-a-1')",
          [aTicketId],
        );
      });
    } catch {
      rejected = true;
    }
    check("duplicate (tenant, idempotency_key) rejected by unique index", rejected);
  }

  await clean();
  await superPool.end();
  await appPool.end();
  await relayPool.end();

  if (failures > 0) {
    console.error(`\nISOLATION HARNESS: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nISOLATION HARNESS: all checks green");
}

main().catch((e) => {
  console.error("isolation harness ERROR", e);
  process.exit(1);
});
