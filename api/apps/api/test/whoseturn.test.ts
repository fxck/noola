import pg from "pg";
import { appPool, relayPool, withTenant } from "@repo/db";
import { ingestInbound } from "../src/ingest.js";
import { modelDriver, type WhoseTurn } from "../src/model.js";

// AI eval harness for the whose-turn classifier. Part 1 is a LABELED SET the active
// ModelServingDriver must classify correctly — the bar any future model (ONNX,
// hosted) has to clear behind the same seam. Part 2 proves the driver's verdict
// actually flows through ingestInbound into tickets.whose_turn. Exit 1 on fail.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)

interface Case { authorType: "customer" | "agent"; body: string; want: WhoseTurn; note: string }

const CASES: Case[] = [
  // customers waiting on us
  { authorType: "customer", body: "My checkout is broken, please help!", want: "us", note: "customer problem" },
  { authorType: "customer", body: "The payment still fails every time", want: "us", note: "customer unresolved" },
  { authorType: "customer", body: "How do I export my data?", want: "us", note: "customer question" },
  // customers NOT waiting on us (closers)
  { authorType: "customer", body: "Thanks, that fixed it!", want: "customer", note: "closer: thanks+fixed" },
  { authorType: "customer", body: "thank you so much, it works now", want: "customer", note: "closer: works now" },
  { authorType: "customer", body: "cheers, all good", want: "customer", note: "closer: all good" },
  { authorType: "customer", body: "no further questions, resolved", want: "customer", note: "closer: resolved" },
  // closer + a fresh question still needs us
  { authorType: "customer", body: "Thanks! But one more thing — how do I add a teammate?", want: "us", note: "closer+ask" },
  // agents putting the ball back on the customer
  { authorType: "agent", body: "Can you send me the error logs?", want: "customer", note: "agent asks customer" },
  { authorType: "agent", body: "Here's the fix: restart the service and retry.", want: "customer", note: "agent resolves" },
  // agents holding the ticket
  { authorType: "agent", body: "I'll look into it and get back to you shortly.", want: "us", note: "agent self-hold" },
  { authorType: "agent", body: "Let me investigate this on our side.", want: "us", note: "agent self-hold" },
  { authorType: "agent", body: "on it", want: "us", note: "agent self-hold (terse)" },
];

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
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432), database: process.env.DB_NAME,
    user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 1,
  });

  // ---- Part 1: eval set ----
  console.log(`whose-turn eval — driver "${modelDriver.name}", ${CASES.length} cases`);
  let correct = 0;
  for (const c of CASES) {
    const got = await modelDriver.classifyWhoseTurn({ authorType: c.authorType, body: c.body });
    const ok = got === c.want;
    if (ok) correct++;
    check(`[${c.authorType}] ${c.note} → ${c.want}${ok ? "" : ` (got ${got})`}`, ok);
  }
  const acc = correct / CASES.length;
  console.log(`  accuracy ${(acc * 100).toFixed(0)}% (${correct}/${CASES.length})`);
  check("baseline driver classifies the full eval set", correct === CASES.length);

  // ---- Part 2: the verdict flows through ingest into tickets.whose_turn ----
  const clean = async () => {
    await superPool.query("DELETE FROM messages WHERE body LIKE 'WTTEST%'");
    await superPool.query("DELETE FROM tickets WHERE external_channel_id LIKE 'wttest-%'");
    await superPool.query("DELETE FROM outbox WHERE payload->'data'->>'body' LIKE 'WTTEST%'");
  };
  await clean();

  // customer opens a ticket → whose_turn = us
  const r = await ingestInbound({
    tenantId: A, body: "WTTEST the app keeps crashing", authorType: "customer",
    idempotencyKey: "wttest-1", channelType: "synthetic", externalChannelId: "wttest-thread",
  });
  await withTenant(A, async (c) => {
    const t = await c.query("SELECT whose_turn FROM tickets WHERE id = $1", [r.ticketId]);
    check("customer message → ticket whose_turn = us", t.rows[0].whose_turn === "us");
  });

  // agent self-holds on the same ticket → whose_turn flips to us (not the naive 'customer')
  await ingestInbound({
    tenantId: A, body: "WTTEST I'll look into it and get back to you", authorType: "agent",
    idempotencyKey: "wttest-2", ticketId: r.ticketId,
  });
  await withTenant(A, async (c) => {
    const t = await c.query("SELECT whose_turn FROM tickets WHERE id = $1", [r.ticketId]);
    check("agent self-hold → whose_turn stays us (content beats the author rule)", t.rows[0].whose_turn === "us");
  });

  // agent hands it back → whose_turn = customer
  await ingestInbound({
    tenantId: A, body: "WTTEST here is the fix, please restart", authorType: "agent",
    idempotencyKey: "wttest-3", ticketId: r.ticketId,
  });
  await withTenant(A, async (c) => {
    const t = await c.query("SELECT whose_turn FROM tickets WHERE id = $1", [r.ticketId]);
    check("agent resolution → whose_turn = customer", t.rows[0].whose_turn === "customer");
  });

  await clean();
  await superPool.end();
  await appPool.end();
  await relayPool.end();

  if (failures > 0) {
    console.error(`\nWHOSE-TURN: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nWHOSE-TURN: all checks green");
}

main().catch((e) => {
  console.error("whose-turn eval ERROR", e);
  process.exit(1);
});
