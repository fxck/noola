import pg from "pg";
import { appPool, relayPool } from "@repo/db";
import { ingestInbound } from "../src/ingest.js";
import { hydrateTickets } from "../src/tickets.js";
import {
  ensureTicketsCollection,
  indexTicket,
  searchTicketIds,
  reindexAllTickets,
  deleteTicketDoc,
} from "../src/search.js";

// Search seam + isolation gate: full-text finds tickets by BODY (not just
// subject), the tenant filter_by keeps one tenant's hits out of another's even
// when subjects collide, and row hydration re-guards through RLS so a hit id
// smuggled across tenants yields no row. Needs Typesense + Postgres. Exit 1 on fail.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const B = "22222222-2222-2222-2222-222222222222"; // Globex

// A shared subject word (both tenants) + a body word unique to each — proves
// body search works and that isolation holds despite the subject collision.
const SHARED = "searchzephyr";
const BODY_A = "acmequasar";
const BODY_B = "globexnimbus";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.error(`  FAIL  ${name}`);
  }
}

/** Typesense upsert→search is usually immediate, but poll briefly to de-flake. */
async function searchUntil(tenantId: string, q: string, want: string, tries = 10): Promise<string[]> {
  for (let i = 0; i < tries; i++) {
    const ids = await searchTicketIds(tenantId, q);
    if (ids.includes(want)) return ids;
    await new Promise((r) => setTimeout(r, 150));
  }
  return searchTicketIds(tenantId, q);
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

  await ensureTicketsCollection();

  const clean = async () => {
    await superPool.query("DELETE FROM messages WHERE body LIKE 'SEARCHTEST%'");
    await superPool.query("DELETE FROM tickets WHERE subject LIKE 'SEARCHTEST%'");
  };
  await clean();

  // Two tickets: same subject word, tenant-unique body word.
  const ra = await ingestInbound({
    tenantId: A, body: `SEARCHTEST ${BODY_A} the checkout keeps failing`, authorType: "customer",
    idempotencyKey: "searchtest-a-1", subject: `SEARCHTEST ${SHARED} acme`,
    channelType: "email", externalChannelId: "searchtest-cust-a@example.test",
  });
  const rb = await ingestInbound({
    tenantId: B, body: `SEARCHTEST ${BODY_B} totally different report`, authorType: "customer",
    idempotencyKey: "searchtest-b-1", subject: `SEARCHTEST ${SHARED} globex`,
    channelType: "email", externalChannelId: "searchtest-cust-b@example.test",
  });
  const idA = ra.ticketId;
  const idB = rb.ticketId;

  // Index via the BACKFILL path (event_relay cross-tenant read) — this is what
  // boots do, and it needs the 0005 grant. A regression guard for the missing
  // GRANT that direct indexTicket + RLS hydration would not have caught.
  const n = await reindexAllTickets();
  check("reindexAllTickets reads cross-tenant without a permission error", n >= 2);

  // 1 — body-word search finds the ticket (proves body is indexed, not just subject)
  {
    const ids = await searchUntil(A, BODY_A, idA);
    check("full-text search matches on BODY text", ids.includes(idA));
  }

  // 2 — the mandatory filter_by isolates: A's search for the SHARED subject word
  //     returns A's ticket and never B's (same word, different tenant)
  {
    const ids = await searchUntil(A, SHARED, idA);
    check("shared-word search returns own tenant's hit", ids.includes(idA));
    check("shared-word search NEVER returns the other tenant's hit", !ids.includes(idB));
  }

  // 3 — B sees only its own
  {
    const ids = await searchUntil(B, SHARED, idB);
    check("globex sees its own hit", ids.includes(idB));
    check("globex never sees acme's hit", !ids.includes(idA));
  }

  // 4 — hydration double-guard: rows come back through RLS
  {
    const own = await hydrateTickets(A, [idA]);
    check("hydrate returns the ticket row for its own tenant", own.length === 1 && own[0].id === idA && own[0].subject.includes(SHARED));

    const foreign = await hydrateTickets(A, [idB]);
    check("hydrate DROPS a foreign-tenant id (RLS re-guard)", foreign.length === 0);

    const mixed = await hydrateTickets(A, [idA, idB]);
    check("hydrate of [own, foreign] yields only own", mixed.length === 1 && mixed[0].id === idA);
  }

  // teardown
  await deleteTicketDoc(idA);
  await deleteTicketDoc(idB);
  await clean();
  await superPool.end();
  await appPool.end();
  await relayPool.end();

  if (failures > 0) {
    console.error(`\nSEARCH SEAM: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nSEARCH SEAM: all checks green");
}

main().catch((e) => {
  console.error("search seam ERROR", e);
  process.exit(1);
});
