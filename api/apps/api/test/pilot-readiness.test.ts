import pg from "pg";
import { withTenant } from "@repo/db";
import {
  ticketEmailToken, ticketReplyAddress, parseInboundAddress,
  handleInboundEmail, routeEmailOutbound,
} from "../src/email.js";
import { workspaceSignupsEnabled, demoModeEnabled, publicInstanceConfig } from "../src/instance-config.js";

// Pilot-readiness gate (PILOT-AND-DISCORD-PLAN Part 2): P1 flag semantics, P4 per-conversation
// email reply addressing — token round-trip + forgery rejection, exact-ticket inbound routing
// (the "two open tickets, reply lands on the RIGHT one" correctness fix), reopen-on-reply, and
// (when Mailpit is reachable) the live Reply-To / In-Reply-To / References headers on an outbound
// reply. Data is PILOTTEST/pilottest- prefixed against the shared dev/stage DB.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const SUPPORT = "support@testco.noola.test";        // seeded route → Acme
const CUSTOMER = "pilottest-cust@example.test";

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
    const t = `SELECT id FROM tickets WHERE external_channel_id = '${CUSTOMER}'`;
    await superPool.query(`DELETE FROM messages WHERE ticket_id IN (${t})`);
    await superPool.query(`DELETE FROM tickets WHERE external_channel_id = '${CUSTOMER}'`);
    await superPool.query(`DELETE FROM contacts WHERE email = '${CUSTOMER}'`);
  };
  await clean();

  // ── P1 flag semantics ───────────────────────────────────────────────────────
  delete process.env.DISABLE_WORKSPACE_SIGNUP;
  delete process.env.DISABLE_DEMO_SEED;
  check("signups enabled by default", workspaceSignupsEnabled() === true);
  check("demo mode on by default", demoModeEnabled() === true);
  process.env.DISABLE_WORKSPACE_SIGNUP = "1";
  process.env.DISABLE_DEMO_SEED = "1";
  check("DISABLE_WORKSPACE_SIGNUP=1 closes signups", workspaceSignupsEnabled() === false);
  check("DISABLE_DEMO_SEED=1 disables demo mode", demoModeEnabled() === false);
  const cfg = publicInstanceConfig();
  check("public instance config reflects both flags", cfg.signupsEnabled === false && cfg.demoMode === false);
  delete process.env.DISABLE_WORKSPACE_SIGNUP;
  delete process.env.DISABLE_DEMO_SEED;

  // ── P4: token round-trip + forgery rejection ────────────────────────────────
  const tid = "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9";
  const addr = ticketReplyAddress(SUPPORT, tid);
  check("reply address is a plus-address on the support mailbox", addr.startsWith("support+t.") && addr.endsWith("@testco.noola.test"));
  const parsed = parseInboundAddress(addr);
  check("token round-trips to the exact ticket id", parsed.ticketId === tid && parsed.base === SUPPORT);
  const forged = addr.replace(/\.[0-9a-f]{10}@/, ".0000000000@");
  check("forged signature is rejected (routes by base only)", parseInboundAddress(forged).ticketId === null && parseInboundAddress(forged).base === SUPPORT);
  check("foreign plus-tag routes by base", parseInboundAddress("support+vip@testco.noola.test").base === SUPPORT && parseInboundAddress("support+vip@testco.noola.test").ticketId === null);
  check("plain address unchanged", parseInboundAddress(SUPPORT).base === SUPPORT);
  check("token is deterministic", ticketEmailToken(tid) === ticketEmailToken(tid));

  // ── P4: exact-ticket inbound routing ───────────────────────────────────────
  // Ticket 1 → close it → ticket 2 opens as the contact's live conversation. A tokened reply to
  // ticket 1 must land on ticket 1 (and reopen it), NOT merge into ticket 2 by sender.
  const r1 = await handleInboundEmail({
    messageId: "pilottest-m1@example.test", from: CUSTOMER, fromName: "Pilot Tester",
    to: SUPPORT, subject: "PILOTTEST first issue", body: "PILOTTEST body one",
  });
  check("inbound email opens ticket 1", !!r1 && r1.ticketCreated);
  const t1 = r1!.ticketId;
  await withTenant(A, (c) => c.query("UPDATE tickets SET status = 'closed' WHERE id = $1", [t1]));
  const r2 = await handleInboundEmail({
    messageId: "pilottest-m2@example.test", from: CUSTOMER, fromName: "Pilot Tester",
    to: SUPPORT, subject: "PILOTTEST second issue", body: "PILOTTEST body two",
  });
  check("second email opens ticket 2 (ticket 1 closed)", !!r2 && r2!.ticketId !== t1);

  // Forged token FIRST (t1 still closed): must fall back to contact threading → the contact's
  // open conversation (t2). Ordered before the tokened reply so the expectation is deterministic.
  const rForged = await handleInboundEmail({
    messageId: "pilottest-m4@example.test", from: CUSTOMER, fromName: "Pilot Tester",
    to: forged, subject: "Re: PILOTTEST forged", body: "PILOTTEST forged token reply",
  });
  check("forged token falls back to contact threading (ticket 2)", !!rForged && rForged!.ticketId === r2!.ticketId);

  const r3 = await handleInboundEmail({
    messageId: "pilottest-m3@example.test", from: CUSTOMER, fromName: "Pilot Tester",
    to: ticketReplyAddress(SUPPORT, t1), subject: "Re: PILOTTEST first issue", body: "PILOTTEST reply to the FIRST ticket",
  });
  check("tokened reply routes to the EXACT (first) ticket", !!r3 && r3!.ticketId === t1);
  const t1status = await withTenant(A, async (c) => (await c.query("SELECT status FROM tickets WHERE id = $1", [t1])).rows[0].status as string);
  check("tokened reply reopens the closed ticket", t1status === "open");

  // ── P4: live outbound headers (Mailpit) ─────────────────────────────────────
  const mailpit = process.env.MAILPIT_API_URL;
  if (process.env.SMTP_HOST && mailpit) {
    const marker = `PILOTTEST-out-${Date.now()}`;
    const out = await routeEmailOutbound(
      { tenantId: A, externalChannelId: CUSTOMER, ticketId: t1 },
      marker, "PILOTTEST outbound reply body",
    );
    check("outbound reply delivered via SMTP", out.delivered === true);
    await new Promise((r) => setTimeout(r, 600));
    const list = (await (await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(marker)}`)).json()) as { messages?: { ID: string }[] };
    const id = list.messages?.[0]?.ID;
    check("outbound reply visible in Mailpit", !!id);
    if (id) {
      const full = (await (await fetch(`${mailpit}/api/v1/message/${id}`)).json()) as {
        ReplyTo?: { Address: string }[];
      };
      const replyTo = full.ReplyTo?.[0]?.Address ?? "";
      check("Reply-To is the signed per-ticket address", parseInboundAddress(replyTo).ticketId === t1);
      // Raw headers live on the dedicated /headers endpoint (the message JSON omits them).
      const hdrs = (await (await fetch(`${mailpit}/api/v1/message/${id}/headers`)).json()) as Record<string, string[]>;
      const h = (n: string) => hdrs[n]?.[0] ?? hdrs[n.toLowerCase()]?.[0] ?? "";
      check("In-Reply-To references the customer's last email", h("In-Reply-To").includes("pilottest-m3@example.test"));
      check("References header present", h("References").includes("pilottest-m3@example.test"));
      check("Message-ID carries the ticket token", h("Message-Id").includes(ticketEmailToken(t1).slice(0, 32)));
    }
  } else {
    console.log("  SKIP  Mailpit header checks (SMTP_HOST/MAILPIT_API_URL unset)");
  }

  await clean();
  await superPool.end();
  console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
