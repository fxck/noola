import pg from "pg";
import { ingestSendgridInbound } from "../src/sendgrid-inbound.js";
import { linkEmailRoute } from "../src/email.js";

// Regression gate for the handle-authoritative BYO inbound fix. SendGrid Inbound Parse resolves the
// tenant from the per-tenant :handle in the URL (passed here as opts.tenantId), NOT from the recipient
// address — so a message to a receiving domain that was never registered as an email_route (e.g.
// anything@inbound.zerops.io) must STILL land as a lead + ticket under that tenant. This proves the
// exact production drop (202 "no tenant route") is gone. Also covers the raw-MIME and empty-sender
// guards. Exit 1 on any fail.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const SUPPORT = "sgtest-support@route.test";        // the tenant's registered support address
const CUST = "sgtest-cust@example.test";            // a first-time sender (becomes a lead)

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
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
    await superPool.query("DELETE FROM messages WHERE body LIKE 'SGTEST%'");
    await superPool.query("DELETE FROM messages WHERE idempotency_key LIKE 'email:sgtest-%'");
    await superPool.query("DELETE FROM tickets WHERE external_channel_id LIKE 'sgtest-%'");
    await superPool.query("DELETE FROM email_routes WHERE address LIKE 'sgtest-%'");
  };
  await clean();
  await linkEmailRoute(SUPPORT, A);

  // 1 — recipient on a receiving domain that is NOT a registered route → still ingests under the
  //     handle's tenant (the real production scenario: envelope.to = <anything>@inbound.zerops.io).
  {
    const r = await ingestSendgridInbound(
      {
        envelope: JSON.stringify({ to: ["support@inbound.zerops.io"], from: CUST }),
        to: "support@inbound.zerops.io",
        from: CUST,
        subject: "SGTEST hello",
        text: "SGTEST body from a first-time sender",
        headers: "Message-ID: <sgtest-msg-1@example.test>\n",
      },
      [],
      { tenantId: A, supportAddress: SUPPORT },
    );
    check("unrouted receiving domain still ingests (201)", r.status === 201 && r.ingested === true);
    check("a ticket id is returned", !!r.ticketId);
    const n = await superPool.query(
      "SELECT count(*)::int AS n FROM tickets WHERE tenant_id = $1 AND external_channel_id = $2",
      [A, CUST.toLowerCase()],
    );
    check("lead ticket created under the handle tenant, keyed by sender", n.rows[0].n === 1);
  }

  // 2 — idempotent on Message-ID (SendGrid retries on a slow/failed first POST)
  {
    const r = await ingestSendgridInbound(
      {
        envelope: JSON.stringify({ to: ["support@inbound.zerops.io"], from: CUST }),
        to: "support@inbound.zerops.io", from: CUST, subject: "SGTEST hello",
        text: "SGTEST body from a first-time sender",
        headers: "Message-ID: <sgtest-msg-1@example.test>\n",
      },
      [],
      { tenantId: A, supportAddress: SUPPORT },
    );
    const n = await superPool.query(
      "SELECT count(*)::int AS n FROM messages WHERE idempotency_key = 'email:sgtest-msg-1@example.test'",
    );
    check("retry does not duplicate the message", n.rows[0].n === 1 && r.status <= 201);
  }

  // 3 — raw-MIME mode (only an `email` field) is refused with an actionable reason, not a silent drop
  {
    const r = await ingestSendgridInbound(
      { email: "From: x@y.z\r\nTo: support@inbound.zerops.io\r\n\r\nraw body" },
      [],
      { tenantId: A, supportAddress: SUPPORT },
    );
    check("raw-MIME payload → 202 raw-mime-unsupported", r.status === 202 && r.reason === "raw-mime-unsupported");
  }

  // 4 — empty sender (no parseable From) → 202 empty-sender, no junk contact
  {
    const r = await ingestSendgridInbound(
      { envelope: JSON.stringify({ to: ["support@inbound.zerops.io"] }), to: "support@inbound.zerops.io", text: "SGTEST no from" },
      [],
      { tenantId: A, supportAddress: SUPPORT },
    );
    check("missing From → 202 empty-sender", r.status === 202 && r.reason === "empty-sender");
  }

  await clean();
  await superPool.end();
  if (failures) { console.error(`\nsendgrid-inbound: ${failures} FAILED`); process.exit(1); }
  console.log("sendgrid-inbound: all assertions passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
