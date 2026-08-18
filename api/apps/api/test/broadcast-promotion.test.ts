import pg from "pg";
import { appPool, withTenant } from "@repo/db";
import {
  handleInboundEmail,
  linkEmailRoute,
  broadcastReplyAddress,
  parseInboundAddress,
} from "../src/email.js";
import { listTickets } from "../src/tickets.js";

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

  // ── EAGER (0117): a broadcast opens a conversation per recipient AT SEND ─────
  // Seed an outbound_pending ticket + a recipient row pointing at it (as runSend would), then reply.
  {
    const b3 = await superPool.query(
      "INSERT INTO broadcasts (tenant_id, subject, status, channel) VALUES ($1,'BCASTPROMO eager','sent','email') RETURNING id",
      [A],
    );
    const eagerEmail = "bcastpromo-eager@example.test";
    const co = await superPool.query(
      "INSERT INTO contacts (tenant_id, email, name) VALUES ($1,$2,'Eager Lead') RETURNING id",
      [A, eagerEmail],
    );
    const eagerTicket = await superPool.query(
      `INSERT INTO tickets (tenant_id, subject, channel_type, external_channel_id, contact_id, whose_turn, outbound_pending, source_broadcast_id, support_mode)
       VALUES ($1,'BCASTPROMO eager','email',$2,$3,'customer',true,$4,'staffed') RETURNING id`,
      [A, eagerEmail, co.rows[0].id, b3.rows[0].id],
    );
    const eagerTicketId = eagerTicket.rows[0].id as string;
    await superPool.query(
      "INSERT INTO messages (tenant_id, ticket_id, author_type, body, channel_type, author_kind) VALUES ($1,$2,'agent','BCASTPROMO eager body','email','agent')",
      [A, eagerTicketId],
    );
    const rcE = await superPool.query(
      "INSERT INTO broadcast_recipients (tenant_id, broadcast_id, contact_id, handle, status, ticket_id) VALUES ($1,$2,$3,$4,'sent',$5) RETURNING id",
      [A, b3.rows[0].id, co.rows[0].id, eagerEmail, eagerTicketId],
    );

    // Before reply: the eager ticket is hidden from the active inbox, shown only in the Outbound view.
    const allBefore = await listTickets(A, "all");
    const outboundBefore = await listTickets(A, "outbound");
    check("eager conversation is HIDDEN from the active inbox", !allBefore.some((t) => t.id === eagerTicketId));
    check("eager conversation shows in the Outbound view", outboundBefore.some((t) => t.id === eagerTicketId));

    // The recipient replies → routes onto the SAME eager ticket, clears outbound_pending.
    const r = await handleInboundEmail({
      messageId: "bcastpromo-eager-reply", from: eagerEmail, to: broadcastReplyAddress(ROUTE, rcE.rows[0].id as string),
      subject: "Re: BCASTPROMO eager", body: "BCASTPROMO eager reply",
    });
    check("reply routes onto the eager conversation (no new ticket)", r?.ticketId === eagerTicketId && r?.ticketCreated === false);
    const allAfter = await listTickets(A, "all");
    check("after reply the conversation surfaces into the active inbox", allAfter.some((t) => t.id === eagerTicketId));
    await withTenant(A, async (c) => {
      const t = await c.query("SELECT outbound_pending FROM tickets WHERE id=$1", [eagerTicketId]);
      check("reply cleared outbound_pending", t.rows[0].outbound_pending === false);
    });
    await superPool.query("DELETE FROM messages WHERE ticket_id=$1", [eagerTicketId]);
    await superPool.query("DELETE FROM tickets WHERE id=$1", [eagerTicketId]);
    await superPool.query("DELETE FROM contacts WHERE email=$1", [eagerEmail]);
  }

  await clean();
  await superPool.end();
  await appPool.end();
  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall broadcast-promotion checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
