import pg from "pg";
import { appPool, relayPool } from "@repo/db";
import {
  ensureThreadsCollection,
  indexResolvedThread,
  unindexThread,
  searchResolvedThreads,
  reindexAllThreads,
} from "../src/threads.js";
import { suggestReply } from "../src/copilot.js";
import { ingestInbound } from "../src/ingest.js";
import { setTicketStatus } from "../src/tickets.js";
import { ensureKbCollection, ensureChunksCollection } from "../src/search.js";

// Resolved-threads-as-KB: closing a ticket makes its thread retrievable as a
// knowledge source; Copilot cites it on a similar new question; tenant isolation
// holds; reopening removes it; backfill re-indexes closed tickets. Needs PG + Typesense.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const B = "22222222-2222-2222-2222-222222222222"; // Globex
const MARK = "threadxyphos"; // distinctive word in the resolved answer + the new question

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

async function searchUntil(tenantId: string, q: string, want: (h: { ticket_id: string }[]) => boolean, tries = 12) {
  for (let i = 0; i < tries; i++) {
    const hits = await searchResolvedThreads(tenantId, q);
    if (want(hits)) return hits;
    await new Promise((r) => setTimeout(r, 150));
  }
  return searchResolvedThreads(tenantId, q);
}

/** Create a ticket with a customer question + an agent answer, then close it. */
async function resolvedTicket(tenantId: string, subject: string, question: string, answer: string) {
  const q = await ingestInbound({ tenantId, authorType: "customer", subject, body: question });
  await ingestInbound({ tenantId, authorType: "agent", ticketId: q.ticketId, body: answer });
  await setTicketStatus(tenantId, q.ticketId, "closed");
  await indexResolvedThread(tenantId, q.ticketId);
  return q.ticketId;
}

async function main() {
  const superPool = new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432), database: process.env.DB_NAME,
    user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 1,
  });
  await ensureThreadsCollection();
  await ensureKbCollection();
  await ensureChunksCollection();

  const created: string[] = [];
  const clean = async () => {
    for (const id of created) await unindexThread(id).catch(() => {});
    await superPool.query("DELETE FROM tickets WHERE subject LIKE 'THREADTEST%'");
  };
  await clean();
  created.length = 0;

  // ---- Acme resolves a ticket whose agent answer holds MARK ----
  const a1 = await resolvedTicket(
    A, "THREADTEST vpn setup",
    `How do I connect to the ${MARK} VPN from a new laptop?`,
    `Install the ${MARK} client from the portal, sign in with SSO, and pick the EU gateway. That's the whole setup.`,
  );
  created.push(a1);
  // Globex resolves its OWN ticket with the same word — the isolation trap.
  const b1 = await resolvedTicket(
    B, "THREADTEST globex vpn",
    `Globex ${MARK} access?`,
    `Globex internal ${MARK} runbook — restricted, must never reach Acme.`,
  );
  created.push(b1);

  // ---- retrieval finds our own resolved thread, never the other tenant's ----
  {
    const hits = await searchUntil(A, MARK, (h) => h.some((x) => x.ticket_id === a1));
    check("resolved thread is retrievable by its content", hits.some((h) => h.ticket_id === a1));
    check("retrieval NEVER returns the other tenant's thread", !hits.some((h) => h.ticket_id === b1));
    check("a hit carries the subject + grounding text", hits.some((h) => h.ticket_id === a1 && h.subject.length > 0 && h.text.includes(MARK)));
  }
  {
    const hits = await searchResolvedThreads(B, MARK);
    check("globex retrieves its own thread", hits.some((h) => h.ticket_id === b1));
    check("globex never retrieves acme's thread", !hits.some((h) => h.ticket_id === a1));
  }

  // ---- Copilot cites the resolved thread on a similar NEW question ----
  {
    const q = await ingestInbound({ tenantId: A, authorType: "customer", subject: "THREADTEST new question", body: `Hi, can you remind me how to set up the ${MARK} VPN?` });
    created.push(q.ticketId);
    let s = await suggestReply(A, q.ticketId);
    for (let i = 0; i < 10 && !s.citations.some((c) => c.kind === "thread"); i++) {
      await new Promise((r) => setTimeout(r, 150));
      s = await suggestReply(A, q.ticketId);
    }
    check("suggest cites the resolved thread", s.citations.some((c) => c.kind === "thread" && c.id === a1));
    check("thread citation is labelled Resolved: <subject>", s.citations.some((c) => c.kind === "thread" && c.title.startsWith("Resolved:")));
    check("draft is grounded in the past answer (mentions the marker)", s.draft.includes(MARK));
    check("suggest never cites the other tenant's thread", !s.citations.some((c) => c.id === b1));
  }

  // ---- reopening removes the thread from the source ----
  {
    await setTicketStatus(A, a1, "open");
    await unindexThread(a1);
    const hits = await searchUntil(A, MARK, (h) => !h.some((x) => x.ticket_id === a1));
    check("reopened ticket is no longer a retrievable source", !hits.some((h) => h.ticket_id === a1));
    // put it back closed for the backfill check
    await setTicketStatus(A, a1, "closed");
  }

  // ---- backfill re-indexes closed tickets ----
  {
    const n = await reindexAllThreads();
    check("backfill indexes at least the closed tickets", n >= 1);
    const hits = await searchUntil(A, MARK, (h) => h.some((x) => x.ticket_id === a1));
    check("backfilled thread is retrievable again", hits.some((h) => h.ticket_id === a1));
  }

  await clean();
  await superPool.end();
  await appPool.end();
  await relayPool.end();

  if (failures > 0) { console.error(`\nTHREADS: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nTHREADS: all checks green");
}

main().catch((e) => { console.error("threads seam ERROR", e); process.exit(1); });
