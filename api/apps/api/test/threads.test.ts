import crypto from "node:crypto";
import pg from "pg";
import { appPool, relayPool } from "@repo/db";
import {
  ensureThreadsCollection,
  indexResolvedThread,
  unindexThread,
  searchResolvedThreads,
  reindexAllThreads,
} from "../src/threads.js";
import { suggestForQuery, suggestReply } from "../src/copilot.js";
import { computeUserHash, resolveVerifiedIdentity, trustedIdentity, type WidgetKey } from "../src/widget.js";
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
async function resolvedTicket(tenantId: string, subject: string, question: string, answer: string, email?: string) {
  const q = await ingestInbound({ tenantId, authorType: "customer", subject, body: question, identity: email ? { email } : undefined });
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
    await superPool.query("DELETE FROM contacts WHERE email LIKE 'threadtest-%' OR name = 'THREADTEST id'");
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

  // ---- a customer-facing answer uses only the verified customer's own past conversations ----
  {
    const OWN = "threadownzebra";
    const own = await resolvedTicket(
      A, "THREADTEST own invoice", `Why is my ${OWN} invoice higher?`, `Your ${OWN} invoice includes the extra seats you added in May.`, "threadtest-owner@x.example",
    );
    created.push(own);
    await searchUntil(A, OWN, (h) => h.some((x) => x.ticket_id === own));
    const ask = async (email: string) => {
      const q = await ingestInbound({ tenantId: A, authorType: "customer", subject: "THREADTEST own question", body: `About my ${OWN} invoice again?`, identity: { email } });
      created.push(q.ticketId);
      return q.ticketId;
    };
    const owner = await ask("threadtest-owner@x.example");
    const stranger = await ask("threadtest-stranger@x.example");
    type Proven = { userId: string | null; email: string | null };
    const threads = async (ticketId: string, opts: { customerFacing?: boolean; verifiedCustomer?: Proven }) =>
      (await suggestForQuery(A, `About my ${OWN} invoice again?`, { ticketId, source: "eval", forceScope: ["thread"], ...opts }))
        .citations.filter((c) => c.kind === "thread").map((c) => c.id);
    check("an agent's draft may use any customer's conversation", (await threads(stranger, {})).includes(own));
    check("an unverified customer-facing answer uses no past conversations", (await threads(owner, { customerFacing: true })).length === 0);
    const ownerProof: Proven = { userId: null, email: "threadtest-owner@x.example" };
    const verified = await threads(owner, { customerFacing: true, verifiedCustomer: ownerProof });
    check("a verified customer's answer uses their own past conversation", verified.includes(own));
    check("and nobody else's", verified.every((id) => id === own));
    check("a verified stranger's answer never uses another customer's conversation",
      !(await threads(stranger, { customerFacing: true, verifiedCustomer: { userId: null, email: "threadtest-stranger@x.example" } })).includes(own));
    check("a proof of another identity unlocks nothing on the owner's ticket",
      (await threads(owner, { customerFacing: true, verifiedCustomer: { userId: "threadtest-attacker", email: null } })).length === 0);

  }

  // ---- widget identity: a proof covers one handle, and the other never comes from the browser unchecked ----
  {
    for (const [ext, email] of [["threadtest-uid", "threadtest-synced@x.example"], [null, "threadtest-victim@x.example"], ["threadtest-noemail", null]]) {
      await superPool.query("INSERT INTO contacts (tenant_id, external_id, email, name) VALUES ($1, $2, $3, 'THREADTEST id')", [A, ext, email]);
    }
    const wk = { tenantId: A, identitySecret: "threadtest-secret" } as WidgetKey;
    const hash = (v: string) => computeUserHash("threadtest-secret", v);
    const trust = (userId: string | null, email: string | null, proof: string | null) =>
      trustedIdentity(wk, { userId, email, userHash: proof ? hash(proof) : null });

    const forged = resolveVerifiedIdentity(wk, { userId: "threadtest-attacker", email: "threadtest-victim@x.example", userHash: hash("threadtest-attacker") });
    check("a hash for the user id proves the user id and not the e-mail", forged.verified && forged.proven.userId === "threadtest-attacker" && forged.proven.email === null);
    check("a hash for the e-mail proves the e-mail", resolveVerifiedIdentity(wk, { email: "threadtest-victim@x.example", userHash: hash("threadtest-victim@x.example") }).proven.email === "threadtest-victim@x.example");

    const synced = await trust("threadtest-uid", "threadtest-victim@x.example", "threadtest-uid");
    check("a proven user id takes the stored contact's e-mail, not the browser's", synced.email === "threadtest-synced@x.example", synced);
    const taken = await trust("threadtest-newuid", "threadtest-victim@x.example", "threadtest-newuid");
    check("an e-mail that another contact holds is dropped", taken.userId === "threadtest-newuid" && taken.email === null, taken);
    const mixedCase = await trust("threadtest-newuid", "ThreadTest-Victim@X.example", "threadtest-newuid");
    check("the holder check ignores case", mixedCase.email === null, mixedCase);
    const fresh = await trust("threadtest-newuid", "threadtest-fresh@x.example", "threadtest-newuid");
    check("a new person's e-mail is kept while nobody holds it", fresh.email === "threadtest-fresh@x.example", fresh);
    const noEmail = await trust("threadtest-noemail", "threadtest-victim@x.example", "threadtest-noemail");
    check("a stored contact without an e-mail still can't take a held one", noEmail.email === null, noEmail);
    const fromEmail = await trust(null, "threadtest-synced@x.example", "threadtest-synced@x.example");
    check("a proven e-mail takes the stored contact's user id", fromEmail.userId === "threadtest-uid", fromEmail);
    const otherId = await trust("threadtest-uid", "threadtest-victim@x.example", "threadtest-victim@x.example");
    check("a user id that another contact holds is dropped", otherId.email === "threadtest-victim@x.example" && otherId.userId === null, otherId);
    // Whatever the database locale lowercases İ to, a kept e-mail must not be one that another contact holds.
    const dotted = await trust("threadtest-newuid", "threadtest-vİctim@x.example", "threadtest-newuid");
    const dottedHolders = dotted.email
      ? (await superPool.query("SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1 AND lower(email) = lower($2)", [A, dotted.email])).rows[0].n
      : 0;
    check("an e-mail that only Unicode case folding tells apart is still checked against holders", dottedHolders === 0, dotted);
    const jwt = (claims: Record<string, string>) => {
      const part = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
      const body = `${part({ alg: "HS256", typ: "JWT" })}.${part(claims)}`;
      return `${body}.${crypto.createHmac("sha256", "threadtest-secret").update(body).digest("base64url")}`;
    };
    const jwtId = await trustedIdentity(wk, { email: "threadtest-victim@x.example", userJwt: jwt({ user_id: "threadtest-uid" }) });
    check("a JWT with only a user id takes the stored contact's e-mail", jwtId.email === "threadtest-synced@x.example", jwtId);
    const jwtEmail = await trustedIdentity(wk, { userId: "threadtest-uid", userJwt: jwt({ email: "threadtest-victim@x.example" }) });
    check("a JWT with only an e-mail never takes another contact's user id", jwtEmail.userId === null, jwtEmail);
    const unverified = await trust("threadtest-uid", "threadtest-victim@x.example", null);
    check("an unverified request keeps its claims for the route to judge", !unverified.verified && unverified.email === "threadtest-victim@x.example", unverified);
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
