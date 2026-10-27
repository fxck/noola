import Fastify from "fastify";
import pg from "pg";
import { relayPool } from "@repo/db";
import widgetRoutes from "../src/routes/widget.js";
import { createWidgetKey } from "../src/widget.js";
import { ingestInbound } from "../src/ingest.js";

// A widget visitor switching between "Talk to a human" and "Ask Noola": the inbox is told about every switch,
// and the handoff request isn't posted again until someone has answered it. WHOTEST data, removed at the end.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)

let failures = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${got !== undefined ? ` — got: ${JSON.stringify(got)}` : ""}`); }
}

async function main() {
  const superPool = new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME, user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 1,
  });
  const key = await createWidgetKey(A, { label: "WHOTEST" });
  const app = Fastify();
  await app.register(widgetRoutes);
  const post = (url: string, body: Record<string, unknown>) =>
    app.inject({ method: "POST", url, payload: { key: key.publicKey, ...body } }).then((r) => ({ status: r.statusCode, body: r.json() as Record<string, unknown> }));

  let ticketId = "";
  try {
    const first = await post("/public/ask", { question: "WHOTEST my export is stuck", clientMessageId: "whotest-q1", email: "whotest@example.invalid" });
    if (!first.body.conversationId) throw new Error(`first turn failed: ${first.status} ${JSON.stringify(first.body)}`);
    ticketId = String(first.body.conversationId);
    const handoffs = async () =>
      Number((await superPool.query("SELECT count(*)::int AS n FROM messages WHERE ticket_id = $1 AND idempotency_key LIKE 'widget:esc-%'", [ticketId])).rows[0].n);
    const aiOn = async () => (await superPool.query("SELECT assistant_enabled FROM tickets WHERE id = $1", [ticketId])).rows[0].assistant_enabled as boolean;
    const updates = async () =>
      Number((await superPool.query("SELECT count(*)::int AS n FROM outbox WHERE event_type = 'ticket.updated' AND payload->>'ticketId' = $1", [ticketId])).rows[0].n);
    const escalate = (seq: number) =>
      post("/public/ask", {
        question: "I’d like to talk to a human, please.", conversationId: ticketId, escalate: true,
        clientMessageId: `esc-${ticketId}-${seq}`, email: "whotest@example.invalid",
      });

    await escalate(0);
    check("the first handoff posts the request and pauses the AI", (await handoffs()) === 1 && !(await aiOn()));

    const before = await updates();
    await post("/public/assistant-mode", { conversationId: ticketId, enabled: true });
    check("going back to the AI tells the inbox", (await aiOn()) && (await updates()) > before, { before, after: await updates() });

    await superPool.query("UPDATE tickets SET whose_turn = 'customer' WHERE id = $1", [ticketId]);
    const repeat = await escalate(1);
    const turn = (await superPool.query("SELECT whose_turn FROM tickets WHERE id = $1", [ticketId])).rows[0].whose_turn;
    check("asking for a human again before anyone answered posts nothing new", repeat.body.escalated === true && (await handoffs()) === 1 && !(await aiOn()), repeat.body);
    check("it puts the ticket back in the needs-reply queue", turn === "us", turn);

    await post("/public/assistant-mode", { conversationId: ticketId, enabled: true });
    await ingestInbound({ tenantId: A, ticketId, body: "WHOTEST the AI's answer", authorType: "agent", idempotencyKey: "whotest:answer" });
    await escalate(2);
    check("after an answer, asking for a human posts the request again", (await handoffs()) === 2 && !(await aiOn()));

    // A second tab repeating the handoff after an agent answered leaves the ticket off the needs-reply queue.
    await ingestInbound({ tenantId: A, ticketId, body: "WHOTEST a teammate's answer", authorType: "agent", idempotencyKey: "whotest:teammate" });
    await superPool.query("UPDATE tickets SET whose_turn = 'customer' WHERE id = $1", [ticketId]);
    await escalate(2);
    const afterStale = (await superPool.query("SELECT whose_turn FROM tickets WHERE id = $1", [ticketId])).rows[0].whose_turn;
    check("a stale repeat after an answer doesn't requeue the ticket", afterStale === "customer" && (await handoffs()) === 2, afterStale);
  } finally {
    const t = "SELECT id FROM tickets WHERE contact_id IN (SELECT id FROM contacts WHERE tenant_id = $1 AND email = 'whotest@example.invalid')";
    await superPool.query(`DELETE FROM messages WHERE ticket_id IN (${t})`, [A]);
    await superPool.query(`DELETE FROM tickets WHERE id IN (${t})`, [A]);
    await superPool.query("DELETE FROM contacts WHERE tenant_id = $1 AND email = 'whotest@example.invalid'", [A]);
    await relayPool.query("DELETE FROM widget_keys WHERE public_key = $1", [key.publicKey]);
    await app.close();
    await superPool.end();
  }
  console.log(failures ? `\n${failures} FAILURES` : "\nWIDGET-HANDOFF: all checks green");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
