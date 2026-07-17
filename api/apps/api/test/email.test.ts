import pg from "pg";
import { appPool, relayPool, withTenant } from "@repo/db";
import { handleInboundEmail, routeEmailOutbound, linkEmailRoute } from "../src/email.js";

// Slice-05 seam gate: proves the email channel resolves recipient→tenant, ingests
// into ticket+message+outbox, dedupes on the Message-ID, guards the echo loop
// (our own outbound never re-ingests), and holds tenant isolation — all WITHOUT
// Mailpit. Exit 1 on any fail.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const B = "22222222-2222-2222-2222-222222222222"; // Globex

const ROUTE_A = "emailtest-acme@route.test";
const ROUTE_B = "emailtest-globex@route.test";
const CUST_A = "emailtest-cust-a@example.test";
const CUST_B = "emailtest-cust-b@example.test";
const MSG_A1 = "EMAILTEST hello from acme customer";

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
    await superPool.query("DELETE FROM messages WHERE body LIKE 'EMAILTEST%'");
    await superPool.query("DELETE FROM messages WHERE idempotency_key LIKE 'email:emailtest-%'");
    await superPool.query("DELETE FROM tickets WHERE external_channel_id LIKE 'emailtest-%'");
    await superPool.query("DELETE FROM outbox WHERE payload->'data'->>'body' LIKE 'EMAILTEST%'");
    await superPool.query("DELETE FROM email_routes WHERE address LIKE 'emailtest-%'");
  };
  await clean();

  // route two support addresses to two tenants
  await linkEmailRoute(ROUTE_A, A);
  await linkEmailRoute(ROUTE_B, B);

  // 1 — mail to an unrouted recipient creates nothing (also the ECHO GUARD:
  //     our own outbound has To=customer, which resolves to no tenant route)
  {
    const r = await handleInboundEmail({
      messageId: "emailtest-echo-1", from: ROUTE_A, to: CUST_A,
      subject: "EMAILTEST our own reply bouncing back", body: "EMAILTEST echo",
    });
    check("unrouted recipient → handleInboundEmail returns null (echo guard)", r === null);
    const n = await superPool.query(
      "SELECT count(*)::int AS n FROM tickets WHERE external_channel_id = $1", [ROUTE_A.toLowerCase()],
    );
    check("our-own-outbound recipient created no ticket", n.rows[0].n === 0);
  }

  // 2 — mail to a routed support address → ticket + message + outbox, tenant A only
  let acmeTicketId = "";
  {
    const r = await handleInboundEmail({
      messageId: "emailtest-a-1", from: CUST_A, to: ROUTE_A,
      subject: "EMAILTEST subject", body: MSG_A1,
    });
    check("routed recipient → ingest returns a result", r !== null);
    check("first message is not a replay", r?.replay === false);
    check(
      "ticket typed as the email channel, keyed by the customer address",
      r?.channelType === "email" && r?.externalChannelId === CUST_A,
    );
    acmeTicketId = r ? r.ticketId : "";

    await withTenant(A, async (c) => {
      const t = await c.query(
        "SELECT channel_type, external_channel_id FROM tickets WHERE id = $1", [acmeTicketId],
      );
      check(
        "Acme sees the email ticket (channel_type=email, customer as external id)",
        t.rowCount === 1 && t.rows[0].channel_type === "email" && t.rows[0].external_channel_id === CUST_A,
      );
      const m = await c.query("SELECT count(*)::int AS n FROM messages WHERE ticket_id = $1", [acmeTicketId]);
      check("Acme ticket carries exactly 1 message", m.rows[0].n === 1);
    });

    const ob = await relayPool.query(
      "SELECT subject FROM outbox WHERE payload->'data'->>'body' = $1", [MSG_A1],
    );
    check(
      "outbox event emitted with the per-tenant subject",
      ob.rowCount === 1 && ob.rows[0].subject === `noola.events.${A}`,
    );
  }

  // 3 — a second email from the same customer appends to the same ticket
  {
    const r = await handleInboundEmail({
      messageId: "emailtest-a-2", from: CUST_A, to: ROUTE_A,
      subject: "EMAILTEST second", body: "EMAILTEST second message",
    });
    check("second email from the same customer reuses the ticket", r?.ticketId === acmeTicketId);
    await withTenant(A, async (c) => {
      const t = await c.query(
        "SELECT count(*)::int AS n FROM tickets WHERE external_channel_id = $1", [CUST_A],
      );
      check("still exactly one ticket for the customer", t.rows[0].n === 1);
    });
  }

  // 4 — redelivery of the same Message-ID dedupes
  {
    const r = await handleInboundEmail({
      messageId: "emailtest-a-1", from: CUST_A, to: ROUTE_A,
      subject: "EMAILTEST subject", body: MSG_A1,
    });
    check("replayed Message-ID → replay=true", r?.replay === true);
    await withTenant(A, async (c) => {
      const m = await c.query(
        "SELECT count(*)::int AS n FROM messages WHERE idempotency_key = 'email:emailtest-a-1'",
      );
      check("no duplicate message for the replayed Message-ID", m.rows[0].n === 1);
    });
  }

  // 5 — cross-tenant: mail to Globex's address never lands in Acme
  {
    const r = await handleInboundEmail({
      messageId: "emailtest-b-1", from: CUST_B, to: ROUTE_B,
      subject: "EMAILTEST globex", body: "EMAILTEST globex only",
    });
    check("globex recipient resolves + ingests", r !== null && r?.channelType === "email");
    await withTenant(A, async (c) => {
      const t = await c.query("SELECT count(*)::int AS n FROM tickets WHERE external_channel_id = $1", [CUST_B]);
      check("Acme cannot see Globex's email ticket (isolation holds)", t.rows[0].n === 0);
    });
    await withTenant(B, async (c) => {
      const t = await c.query("SELECT count(*)::int AS n FROM tickets WHERE external_channel_id = $1", [CUST_B]);
      check("Globex sees its own email ticket", t.rows[0].n === 1);
    });
  }

  // 6 — outbound seam (no live SMTP): reports disabled / no-recipient cleanly
  {
    const noRcpt = await routeEmailOutbound({ tenantId: A, externalChannelId: null }, "s", "b");
    check("routeEmailOutbound no-ops without a recipient", noRcpt.delivered === false && noRcpt.reason === "no-recipient");

    const savedHost = process.env.SMTP_HOST;
    delete process.env.SMTP_HOST; // force the disabled path regardless of ambient env
    const disabled = await routeEmailOutbound({ tenantId: A, externalChannelId: CUST_A }, "EMAILTEST subject", "reply");
    if (savedHost !== undefined) process.env.SMTP_HOST = savedHost;
    check(
      "routeEmailOutbound reports disabled when SMTP is unset",
      disabled.delivered === false && disabled.reason === "email-disabled",
    );
  }

  await clean();
  await superPool.end();
  await appPool.end();
  await relayPool.end();

  if (failures > 0) {
    console.error(`\nEMAIL SEAM: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nEMAIL SEAM: all checks green");
}

main().catch((e) => {
  console.error("email seam ERROR", e);
  process.exit(1);
});
