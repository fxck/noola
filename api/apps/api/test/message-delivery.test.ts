import pg from "pg";
import { recordDeliveryEvent } from "../src/broadcast-events.js";

// Per-message reply-email delivery tracking (0114). A provider delivery webhook, after failing to
// match a broadcast recipient, matches a 1:1 agent reply by the Message-ID we stamped at send and
// advances the messages delivery head (sent → delivered / bounced / complained; opened unifies with
// the seen pixel). A reply hard-bounce still parks the address in email_suppressions. Postgres only.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo

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
  const clean = async () => {
    await superPool.query("DELETE FROM messages WHERE provider_message_id LIKE 'mdlv-%'");
    await superPool.query("DELETE FROM email_suppressions WHERE address LIKE 'mdlv-%'");
    await superPool.query("DELETE FROM tickets WHERE subject LIKE 'MDLV%'");
  };
  await clean();

  const tk = await superPool.query(
    "INSERT INTO tickets (tenant_id, subject, channel_type) VALUES ($1,'MDLV delivery',$2) RETURNING id",
    [A, "email"],
  );
  const ticketId = tk.rows[0].id as string;

  const mkMsg = async (pmid: string) => {
    const r = await superPool.query(
      `INSERT INTO messages (tenant_id, ticket_id, author_type, channel_type, body, provider_message_id, delivery_status)
       VALUES ($1,$2,'agent','email','reply',$3,'sent') RETURNING id`,
      [A, ticketId, pmid],
    );
    return r.rows[0].id as string;
  };

  // ── delivered ──────────────────────────────────────────────────────────────
  const pmid1 = "mdlv-1@test.local";
  const m1 = await mkMsg(pmid1);
  const r1 = await recordDeliveryEvent(A, { type: "delivered", messageId: pmid1, address: "mdlv-a@x.io" });
  check("delivered matched the reply message", r1.matched === true);
  const g1 = await superPool.query("SELECT delivery_status, delivered_at FROM messages WHERE id=$1", [m1]);
  check("delivery_status → delivered + delivered_at", g1.rows[0].delivery_status === "delivered" && g1.rows[0].delivered_at !== null);

  // ── opened unifies opened_at + seen_at ──────────────────────────────────────
  await recordDeliveryEvent(A, { type: "opened", messageId: pmid1, address: "mdlv-a@x.io" });
  const g2 = await superPool.query("SELECT opened_at, seen_at FROM messages WHERE id=$1", [m1]);
  check("opened stamps opened_at AND seen_at", g2.rows[0].opened_at !== null && g2.rows[0].seen_at !== null);

  // ── hard bounce → bounced head + suppression ────────────────────────────────
  const pmid2 = "mdlv-2@test.local";
  const m2 = await mkMsg(pmid2);
  const r2 = await recordDeliveryEvent(A, { type: "bounced", bounceKind: "hard", messageId: pmid2, address: "mdlv-bounce@x.io" });
  check("bounce matched + suppressed", r2.matched === true && r2.suppressed === true);
  const g3 = await superPool.query("SELECT delivery_status, bounce_kind, bounced_at FROM messages WHERE id=$1", [m2]);
  check("delivery_status → bounced (hard)", g3.rows[0].delivery_status === "bounced" && g3.rows[0].bounce_kind === "hard" && g3.rows[0].bounced_at !== null);
  const sup = await superPool.query("SELECT 1 FROM email_suppressions WHERE lower(address)='mdlv-bounce@x.io'");
  check("hard bounce parks the address in suppressions", sup.rowCount === 1);

  // ── no-regression: a late 'delivered' after a bounce must not overwrite ──────
  await recordDeliveryEvent(A, { type: "delivered", messageId: pmid2, address: "mdlv-bounce@x.io" });
  const g4 = await superPool.query("SELECT delivery_status FROM messages WHERE id=$1", [m2]);
  check("delivered does not regress a bounced head", g4.rows[0].delivery_status === "bounced");

  // ── message-matched events don't pollute the broadcast_events log ────────────
  const bev = await superPool.query("SELECT count(*)::int AS n FROM broadcast_events WHERE address LIKE 'mdlv-%'");
  check("message-matched events append no broadcast_events", bev.rows[0].n === 0);

  // ── an unknown Message-ID matches nothing ───────────────────────────────────
  const r3 = await recordDeliveryEvent(A, { type: "delivered", messageId: "mdlv-nope@test.local", address: "mdlv-z@x.io" });
  check("unknown Message-ID → not matched", r3.matched === false);

  await clean();
  await superPool.end();
  console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
