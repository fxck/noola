import pg from "pg";
import { appPool, relayPool } from "@repo/db";
import { RuleModelDriver, clip } from "../src/model.js";
import { suggestReply } from "../src/copilot.js";
import { ingestInbound } from "../src/ingest.js";
import { ingestDocument } from "../src/documents.js";
import { createArticle } from "../src/kb.js";
import { ensureChunksCollection, ensureKbCollection } from "../src/search.js";

// Copilot seam: the retrieval-augmented suggested reply. The rule driver composes
// an extractive draft from retrieved passages (no source → a safe fallback); the
// end-to-end suggest retrieves the tenant's KB + documents relevant to the latest
// customer message, cites them, and NEVER crosses tenants. Needs Typesense + PG.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const B = "22222222-2222-2222-2222-222222222222"; // Globex
const MARK = "copilotzarquon"; // distinctive word planted in A's KB + doc + question

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

async function suggestUntilCited(tenantId: string, ticketId: string, tries = 12) {
  // retrieval is eventually-consistent (Typesense indexing) — poll until cited
  for (let i = 0; i < tries; i++) {
    const s = await suggestReply(tenantId, ticketId);
    if (s.citations.length) return s;
    await new Promise((r) => setTimeout(r, 150));
  }
  return suggestReply(tenantId, ticketId);
}

async function main() {
  const superPool = new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432), database: process.env.DB_NAME,
    user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 1,
  });
  await ensureChunksCollection();
  await ensureKbCollection();
  const clean = async () => {
    await superPool.query("DELETE FROM documents WHERE filename LIKE 'COPILOT%'");
    await superPool.query("DELETE FROM kb_articles WHERE title LIKE 'COPILOT%'");
    await superPool.query("DELETE FROM tickets WHERE subject LIKE 'COPILOT%'");
  };
  await clean();

  const rule = new RuleModelDriver();

  // ---- unit: clip ----
  check("clip returns short text unchanged", clip("  hello  world ", 40) === "hello world");
  check("clip cuts at a sentence boundary", clip("One sentence. Two sentence. Three.", 20) === "One sentence.");
  check("clip never ends mid-word", !/\w…\w/.test(clip("supercalifragilistic expialidocious extra", 15)));

  // ---- unit: rule draftReply ----
  {
    const noSrc = (await rule.draftReply({ customerMessage: "help", sources: [] })).text;
    check("draftReply with no sources → safe acknowledgement", /looking into this/i.test(noSrc) && noSrc.length > 0);
    const withSrc = (await rule.draftReply({
      customerMessage: "how do refunds work?",
      sources: [{ title: "Billing", text: "We offer a full refund within 30 days of purchase." }],
    })).text;
    check("draftReply grounds the draft in the source text", withSrc.includes("full refund within 30 days"));
    check("draftReply reads like a reply (greeting + sign-off)", /^Hi,/.test(withSrc) && /Best regards\s*$/.test(withSrc));
  }

  // ---- seed A's knowledge: a KB article + a document, both mentioning MARK ----
  const art = await createArticle(A, "COPILOT Refund policy", `Our ${MARK} refund policy: a full refund within 30 days, prorated after.`);
  const doc = await ingestDocument(A, "COPILOT-guide.md", "text/markdown",
    `# Guide\n\nThe ${MARK} escalation path: contact your account manager for anything urgent.`);
  // Globex has its OWN doc with the same distinctive word — the isolation trap.
  const bdoc = await ingestDocument(B, "COPILOT-globex.md", "text/markdown",
    `# Globex\n\nGlobex ${MARK} secret internal runbook — must never leak to Acme.`);

  // ---- a customer message on A's ticket, asking about MARK ----
  const inbound = await ingestInbound({
    tenantId: A, authorType: "customer",
    subject: "COPILOT question", body: `Hi, I have a question about your ${MARK} refund policy — can you help?`,
  });

  // ---- suggest for A ----
  {
    const s = await suggestUntilCited(A, inbound.ticketId);
    check("suggest returns a non-empty draft", s.draft.trim().length > 0);
    // Model name is per-tenant now (a tenant may have a BYO hosted model configured);
    // the run forces the rule baseline for determinism, so assert that name.
    check("suggest reports the model driver name", s.model === "rule");
    check("suggest basedOn reflects the customer message", !!s.basedOn && s.basedOn.includes(MARK));
    check("suggest cites A's KB article", s.citations.some((c) => c.kind === "kb" && c.id === art.id));
    check("suggest cites A's document", s.citations.some((c) => c.kind === "document" && c.id === doc.id));
    check("a KB citation carries a title + snippet", s.citations.some((c) => c.kind === "kb" && c.title.length > 0 && c.snippet.length > 0));
    check("the draft is grounded in A's knowledge (mentions the marker)", s.draft.includes(MARK));
    // THE isolation gate: A's suggestion must never cite Globex's document.
    check("suggest NEVER cites the other tenant's document", !s.citations.some((c) => c.id === bdoc.id));
    check("the draft never leaks Globex's runbook text", !/secret internal runbook/i.test(s.draft));
  }

  // ---- suggest for a ticket with no customer message → safe fallback, no citations ----
  {
    const agentOnly = await ingestInbound({
      tenantId: A, authorType: "agent", subject: "COPILOT agent-only", body: "internal note, no customer yet",
    });
    const s = await suggestReply(A, agentOnly.ticketId);
    check("no customer message → empty citations", s.citations.length === 0);
    check("no customer message → basedOn is null", s.basedOn === null);
    check("no customer message → still a usable fallback draft", s.draft.trim().length > 0);
  }

  await clean();
  await superPool.end();
  await appPool.end();
  await relayPool.end();

  if (failures > 0) { console.error(`\nCOPILOT: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nCOPILOT: all checks green");
}

main().catch((e) => { console.error("copilot seam ERROR", e); process.exit(1); });
