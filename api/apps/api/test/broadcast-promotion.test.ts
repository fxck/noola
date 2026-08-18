import pg from "pg";
import { appPool, withTenant } from "@repo/db";
import {
  handleInboundEmail,
  linkEmailRoute,
  broadcastReplyAddress,
  parseInboundAddress,
} from "../src/email.js";

// Lazy-promotion of broadcast replies (0116). A broadcast holds NO ticket at send time; it stamps a
// signed `+b.<recipientRow>` Reply-To. A recipient's reply carrying that token materializes a ticket
// via normal contact-threading, then gets tagged with the broadcast it answered — so the conversation
// is born with its outbound origin instead of arriving context-free. Also proves: a forged `+b.` token
// routes by base only (no stamp), and first-origin-wins (a later broadcast reply never clobbers).

const A = "33333333-3333-3333-3333-333333333333"; // TestCo

const ROUTE = "bcastpromo-support@route.test";
const CUST = "bcastpromo-cust@example.test";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

async function main() {
  const superPool = new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432), database: process.env.DB_NAME,
    user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 1,
  });
  // Delete order matters: messages carry a composite (tenant_id, author_contact_id) FK to contacts
  // with ON DELETE SET NULL — dropping a still-referenced contact would try to null the NOT-NULL
  // tenant_id. Clear messages (then tickets) before contacts so nothing references them.
  const clean = async () => {
    await superPool.query("DELETE FROM messages WHERE idempotency_key LIKE 'email:bcastpromo-%'");
    await superPool.query("DELETE FROM tickets WHERE external_channel_id LIKE 'bcastpromo-%'");
    await superPool.query("DELETE FROM broadcast_recipients WHERE handle LIKE 'bcastpromo-%'");
    await superPool.query("DELETE FROM broadcasts WHERE subject LIKE 'BCASTPROMO%'");
    await superPool.query("DELETE FROM contacts WHERE email LIKE 'bcastpromo-%'");
    await superPool.query("DELETE FROM email_routes WHERE address = $1", [ROUTE]);
  };
  await clean();

  await linkEmailRoute(ROUTE, A);

  // ── pure token round-trip ──────────────────────────────────────────────────
  {
    const rid = "11111111-2222-3333-4444-555555555555";
    const addr = broadcastReplyAddress(ROUTE, rid);
    const p = parseInboundAddress(addr);
    check("`+b.` token round-trips to the recipient id", p.broadcastRecipientId === rid && p.ticketId === null);
    check("`+b.` base strips the plus-tag back to the route address", p.base === ROUTE.toLowerCase());
    // forge: flip a hex char of the signature → must not verify
    const forged = addr.replace(/\.([0-9a-f])([0-9a-f]{9})@/i, (_m, a, rest) => `.${a === "0" ? "1" : "0"}${rest}@`);
    const pf = parseInboundAddress(forged);
    check("forged `+b.` signature yields no recipient id (routes by base only)", pf.broadcastRecipientId === null && pf.base === ROUTE.toLowerCase());
  }

  // seed a broadcast + recipient row (contact) under tenant A
  const seed = async (subject: string) => {
    const b = await superPool.query(
      "INSERT INTO broadcasts (tenant_id, subject, status, channel) VALUES ($1,$2,'sent','email') RETURNING id",
      [A, subject],
    );
    const broadcastId = b.rows[0].id as string;
    const co = await superPool.query(
      "INSERT INTO contacts (tenant_id, email, name) VALUES ($1,$2,'Promo Lead') RETURNING id",
      [A, CUST],
    );
    const contactId = co.rows[0].id as string;
    const rc = await superPool.query(
      "INSERT INTO broadcast_recipients (tenant_id, broadcast_id, contact_id, handle, status) VALUES ($1,$2,$3,$4,'sent') RETURNING id",
      [A, broadcastId, contactId, CUST],
    );
    return { broadcastId, recipientId: rc.rows[0].id as string };
  };

  // ── reply to a broadcast promotes to a tagged ticket ────────────────────────
  const { broadcastId, recipientId } = await seed("BCASTPROMO launch");
  {
    const to = broadcastReplyAddress(ROUTE, recipientId);
    const r = await handleInboundEmail({
      messageId: "bcastpromo-reply-1", from: CUST, to,
      subject: "Re: BCASTPROMO launch", body: "BCASTPROMO yes I'm interested",
    });
    check("reply to a broadcast ingests a ticket", r !== null && r?.replay === false && r?.ticketCreated === true);
    const tid = r?.ticketId ?? "";
    await withTenant(A, async (c) => {
      const t = await c.query(
        "SELECT source_broadcast_id, source_broadcast_recipient_id FROM tickets WHERE id = $1", [tid],
      );
      check(
        "materialized ticket is tagged with the broadcast origin",
        t.rowCount === 1 &&
          t.rows[0].source_broadcast_id === broadcastId &&
          t.rows[0].source_broadcast_recipient_id === recipientId,
      );
    });
  }

  // ── first-origin-wins: a reply to a SECOND broadcast onto the same open ticket does not clobber ──
  {
    // seed a second broadcast; reuse the same contact (its open ticket from above still exists)
    const b2 = await superPool.query(
      "INSERT INTO broadcasts (tenant_id, subject, status, channel) VALUES ($1,'BCASTPROMO second','sent','email') RETURNING id",
      [A],
    );
    const co = await superPool.query("SELECT id FROM contacts WHERE tenant_id=$1 AND email=$2", [A, CUST]);
    const rc2 = await superPool.query(
      "INSERT INTO broadcast_recipients (tenant_id, broadcast_id, contact_id, handle, status) VALUES ($1,$2,$3,$4,'sent') RETURNING id",
      [A, b2.rows[0].id, co.rows[0].id, CUST],
    );
    const to2 = broadcastReplyAddress(ROUTE, rc2.rows[0].id as string);
    const r2 = await handleInboundEmail({
      messageId: "bcastpromo-reply-2", from: CUST, to: to2,
      subject: "Re: BCASTPROMO second", body: "BCASTPROMO also this one",
    });
    check("second reply threads onto the SAME contact ticket", r2?.ticketId !== undefined);
    await withTenant(A, async (c) => {
      const t = await c.query(
        "SELECT source_broadcast_id FROM tickets WHERE id = $1", [r2?.ticketId ?? ""],
      );
      check("first broadcast origin is preserved (no clobber)", t.rows[0]?.source_broadcast_id === broadcastId);
    });
  }

  // ── forged `+b.` token in a live reply → normal ticket, NO stamp ────────────
  {
    const good = broadcastReplyAddress(ROUTE, recipientId);
    const forged = good.replace(/\.([0-9a-f])([0-9a-f]{9})@/i, (_m, a, rest) => `.${a === "0" ? "1" : "0"}${rest}@`);
    const r = await handleInboundEmail({
      messageId: "bcastpromo-reply-forged", from: "bcastpromo-other@example.test", to: forged,
      subject: "BCASTPROMO forged", body: "BCASTPROMO forged token",
    });
    check("forged token still ingests (routes by base)", r !== null);
    await withTenant(A, async (c) => {
      const t = await c.query("SELECT source_broadcast_id FROM tickets WHERE id = $1", [r?.ticketId ?? ""]);
      check("forged token leaves the ticket unstamped", t.rows[0]?.source_broadcast_id === null);
    });
  }

  await clean();
  await superPool.end();
  await appPool.end();
  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall broadcast-promotion checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
