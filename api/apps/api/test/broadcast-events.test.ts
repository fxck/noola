import pg from "pg";
import { appPool, relayPool } from "@repo/db";
import { createContact } from "../src/contacts.js";
import { createBroadcast, sendBroadcast, getBroadcast, previewSegment, type BroadcastSendFn } from "../src/broadcasts.js";
import {
  recordDeliveryEvent,
  parseResendDeliveryEvent,
  parseSendgridDeliveryEvents,
  listSuppressions,
  removeSuppression,
} from "../src/broadcast-events.js";

// Delivery-event gate (0109): provider webhook payloads normalize to DeliveryEvents; recording an
// event advances the recipient's derived status (first-touch, no regression), appends the analytics
// row, and a hard bounce / complaint parks the address in email_suppressions so it's never re-sent.
// Postgres only. Uses the injected send seam to create real recipient rows with stamped Message-IDs.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

/** Echoes the stamped marketingId back as the Message-ID (like the real Resend/SMTP seam would),
 *  so we can exercise the Message-ID match path. Fails delivery for a chosen address set. */
function stub(failFor: Set<string> = new Set()): BroadcastSendFn {
  return async (_t, to, _s, _b, opts) => {
    if (failFor.has(to.toLowerCase())) return { delivered: false, reason: "stub-fail" };
    return { delivered: true, ...(opts?.marketingId ? { messageId: `${opts.marketingId}@test.local` } : {}) };
  };
}

async function main() {
  const superPool = new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432), database: process.env.DB_NAME,
    user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 1,
  });
  const clean = async () => {
    await superPool.query("DELETE FROM broadcast_events WHERE address LIKE 'bevt-%'");
    await superPool.query("DELETE FROM email_suppressions WHERE address LIKE 'bevt-%'");
    await superPool.query("DELETE FROM broadcast_recipients WHERE broadcast_id IN (SELECT id FROM broadcasts WHERE subject LIKE 'BEVT%')");
    await superPool.query("DELETE FROM broadcasts WHERE subject LIKE 'BEVT%'");
    await superPool.query("DELETE FROM contacts WHERE company = 'BevtCo' OR email LIKE 'bevt-%'");
  };
  await clean();

  // ---- payload parsing ----
  {
    const delivered = parseResendDeliveryEvent({ type: "email.delivered", created_at: "2026-08-11T10:00:00Z", data: { to: ["bevt-x@test.example"] } });
    check("resend email.delivered → delivered", delivered?.type === "delivered" && delivered?.address === "bevt-x@test.example");
    const hard = parseResendDeliveryEvent({ type: "email.bounced", data: { to: ["a@b.c"], bounce: { type: "Permanent" } } });
    check("resend permanent bounce → hard", hard?.type === "bounced" && hard?.bounceKind === "hard");
    const soft = parseResendDeliveryEvent({ type: "email.bounced", data: { to: ["a@b.c"], bounce: { type: "Transient" } } });
    check("resend transient bounce → soft", soft?.type === "bounced" && soft?.bounceKind === "soft");
    const comp = parseResendDeliveryEvent({ type: "email.complained", data: { to: ["a@b.c"] } });
    check("resend complaint → complained", comp?.type === "complained");
    const mid = parseResendDeliveryEvent({ type: "email.opened", data: { to: ["a@b.c"], headers: [{ name: "Message-ID", value: "<b.abc@dom>" }] } });
    check("resend header Message-ID unangled", mid?.type === "opened" && mid?.messageId === "b.abc@dom");
    check("resend non-email type dropped", parseResendDeliveryEvent({ type: "contact.created", data: {} }) === null);

    const sg = parseSendgridDeliveryEvents([
      { email: "one@test.example", event: "delivered", timestamp: 1_700_000_000, "smtp-id": "<b.r1@dom>" },
      { email: "two@test.example", event: "bounce", type: "bounce", timestamp: 1_700_000_001 },
      { email: "three@test.example", event: "bounce", type: "blocked", timestamp: 1_700_000_002 },
      { email: "four@test.example", event: "spamreport", timestamp: 1_700_000_003 },
      { email: "five@test.example", event: "processed" },
    ]);
    check("sendgrid array parses known events, drops unknown", sg.length === 4);
    check("sendgrid delivered mapped + smtp-id → messageId", sg[0].type === "delivered" && sg[0].messageId === "b.r1@dom");
    check("sendgrid type=bounce → hard, type=blocked → soft", sg[1].bounceKind === "hard" && sg[2].bounceKind === "soft");
    check("sendgrid spamreport → complained", sg[3].type === "complained");
  }

  // ---- end-to-end recording + suppression ----
  const seg = { conditionGroups: [[{ field: "company", op: "is", value: "BevtCo" }]] };
  await createContact(A, { email: "bevt-hard@test.example", name: "Hard Bounce", company: "BevtCo" });
  await createContact(A, { email: "bevt-good@test.example", name: "Good", company: "BevtCo" });

  const pre = await previewSegment(A, seg);
  check("both contacts reachable by email before suppression", pre.reachable.email === 2);

  const bc = await createBroadcast(A, { subject: "BEVT Send", body: "hi", channel: "email", segment: seg });
  const res = await sendBroadcast(A, bc.id, { send: stub() });
  await res?.done;

  const got = await getBroadcast(A, bc.id);
  const recips = got?.recipients ?? [];
  check("two recipients logged", recips.length === 2);
  check("recipients carry a stamped message_id", recips.every((r) => !!r.message_id));
  const hardRow = recips.find((r) => r.handle === "bevt-hard@test.example")!;

  // Delivered (via Message-ID match) → status delivered, delivered_at set.
  await recordDeliveryEvent(A, { type: "delivered", messageId: hardRow.message_id, address: hardRow.handle });
  // Bounce (hard) → status bounced + suppression.
  const bounce = await recordDeliveryEvent(A, { type: "bounced", bounceKind: "hard", address: "bevt-hard@test.example" });
  check("hard bounce matched a recipient", bounce.matched);
  check("hard bounce reported suppressed", bounce.suppressed);
  // A late 'delivered' must NOT regress a bounced head.
  await recordDeliveryEvent(A, { type: "delivered", address: "bevt-hard@test.example" });

  const after = await getBroadcast(A, bc.id);
  const hardAfter = after!.recipients.find((r) => r.handle === "bevt-hard@test.example")!;
  const goodAfter = after!.recipients.find((r) => r.handle === "bevt-good@test.example")!;
  check("bounced recipient status = bounced (not regressed by late delivered)", hardAfter.status === "bounced" && !!hardAfter.bounced_at);
  check("good recipient reached delivered", goodAfter.status === "sent"); // no event fired for it yet
  check("stats count the bounce", after!.stats.bounced === 1);

  // Suppression persisted + enforced.
  const supps = await listSuppressions(A);
  check("suppression row present with reason hard_bounce", supps.some((s) => s.address === "bevt-hard@test.example" && s.reason === "hard_bounce"));
  const postSupp = await previewSegment(A, seg);
  check("suppressed address drops out of reachable email count", postSupp.reachable.email === 1);

  // Re-sending resolves only the non-suppressed recipient.
  const bc2 = await createBroadcast(A, { subject: "BEVT Resend", body: "again", channel: "email", segment: seg });
  const res2 = await sendBroadcast(A, bc2.id, { send: stub() });
  await res2?.done;
  const got2 = await getBroadcast(A, bc2.id);
  check("re-send skips the suppressed address", (got2?.recipients ?? []).length === 1 && got2!.recipients[0].handle === "bevt-good@test.example");

  // Un-suppress restores reach.
  const removed = await removeSuppression(A, "bevt-hard@test.example");
  check("removeSuppression removes the row", removed);
  const restored = await previewSegment(A, seg);
  check("un-suppressed address reachable again", restored.reachable.email === 2);

  // Complaint flips the contact's marketing opt-out too.
  await recordDeliveryEvent(A, { type: "complained", address: "bevt-good@test.example" });
  const optout = await superPool.query("SELECT unsubscribed_at FROM contacts WHERE email = 'bevt-good@test.example'");
  check("complaint opts the contact out of marketing", optout.rows[0]?.unsubscribed_at != null);

  // Analytics backbone captured the events.
  const evs = await superPool.query("SELECT type FROM broadcast_events WHERE address LIKE 'bevt-%'");
  check("delivery events appended to the backbone", evs.rows.some((r) => r.type === "bounced") && evs.rows.some((r) => r.type === "complained"));

  await clean();
  await superPool.end();
  await appPool.end();
  await relayPool.end();

  if (failures > 0) { console.error(`\nBROADCAST-EVENTS: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nBROADCAST-EVENTS: all checks green");
}

main().catch((e) => { console.error("broadcast-events ERROR", e); process.exit(1); });
