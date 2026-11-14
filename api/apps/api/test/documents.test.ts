import pg from "pg";
import { appPool, relayPool } from "@repo/db";
import { ingestDocument, getDocument, getDocumentContent, deleteDocument, searchDocuments } from "../src/documents.js";
import { ensureChunksCollection } from "../src/search.js";
import { extractText, chunkText, chunkDocument } from "../src/extract.js";

// Ingestion pipeline seam + isolation gate: a document is stored, extracted,
// chunked into MANY pieces, and every chunk is retrievable by content; the tenant
// filter_by + RLS keep one tenant's chunks out of another's; deleting a document
// cascades its chunks out of the DB and the index. Needs Typesense + Postgres.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const B = "22222222-2222-2222-2222-222222222222"; // Globex
const SHARED = "doczephyr";
const LATE = "quokkaparagraph"; // a word only in a LATE paragraph — proves full-doc chunking

let failures = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${got !== undefined ? ` — got: ${JSON.stringify(got)}` : ""}`); }
}

// a long multi-paragraph document; last paragraph holds LATE
function makeDoc(marker: string): string {
  const paras: string[] = [`DOCTEST ${marker} ${SHARED} intro about billing and invoices.`];
  for (let i = 0; i < 12; i++) {
    paras.push(
      `Section ${i}: this paragraph explains configuration step ${i} in exhaustive detail, ` +
      `covering setup, verification, and rollback so the chunker has plenty of text to split across ` +
      `multiple windows and prove that retrieval reaches every part of the document, not just the head.`,
    );
  }
  paras.push(`Final notes: the ${LATE} appears only here, at the very end of the document.`);
  return paras.join("\n\n");
}

async function searchUntil(tenantId: string, q: string, tries = 12) {
  for (let i = 0; i < tries; i++) {
    const hits = await searchDocuments(tenantId, q);
    if (hits.length) return hits;
    await new Promise((r) => setTimeout(r, 150));
  }
  return searchDocuments(tenantId, q);
}

async function main() {
  const superPool = new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432), database: process.env.DB_NAME,
    user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 1,
  });
  await ensureChunksCollection();
  const clean = async () => { await superPool.query("DELETE FROM documents WHERE filename LIKE 'DOCTEST%'"); };
  await clean();

  // ---- unit: extract + chunk ----
  check("extractText strips HTML tags", extractText("text/html", "<h1>Hi</h1><p>there <b>bold</b></p>").replace(/\s+/g, " ").trim() === "Hi there bold");
  const many = chunkText(makeDoc("acme"));
  check("chunkText splits a long document into several chunks", many.length >= 3);
  check("chunking keeps the late paragraph", many.some((c) => c.includes(LATE)));

  // ---- unit: Markdown sections ----
  const para = (topic: string) => `This section explains ${topic} step by step, with the settings it needs and how to check that it worked afterwards. `.repeat(3);
  const fence = "```powershell\nirm https://zerops.io/zcli/install.ps1 | iex\n\n# not a heading inside the fence\n```";
  const md = [
    "# Using zCLI", para("what zCLI is"),
    "## Install", para("the installation"),
    "### Windows", para("the Windows install"), fence,
    "## Tokens", "Personal tokens give access to your projects. ".repeat(40).trim(),
  ].join("\n\n");
  const MD = "text/markdown";
  const sections = chunkDocument(md, MD);
  check("a passage starts with its heading path", sections.some((p) => p.startsWith("Using zCLI › Install › Windows\n\n") && p.includes("the Windows install")));
  check("a code block stays whole in one passage", sections.some((p) => p.includes("```powershell") && p.includes("# not a heading inside the fence\n```")));
  check("a line inside a code block is not a heading", !sections.some((p) => p.split("\n\n")[0].includes("not a heading")));
  const tokens = sections.filter((p) => p.startsWith("Using zCLI › Tokens\n\n"));
  check("a long section is split into passages that fit", tokens.length >= 2 && tokens.every((p) => p.length <= 1000 + "Using zCLI › Tokens\n\n".length));
  check("a long section is split between sentences", tokens.every((p) => p.endsWith("projects.")));
  const merged = chunkDocument("# Billing\n\nShort intro.\n\n## Invoices\n\nInvoices are issued for top-ups.", MD);
  check("a short section takes in its subsection", merged.length === 1 && merged[0] === "Billing\n\nShort intro.\n\nInvoices\n\nInvoices are issued for top-ups.", merged);
  const siblings = chunkDocument("# Guide\n\n## Linux\n\nRun the script.\n\n## macOS\n\nUse Homebrew.", MD);
  check("short siblings share their parent's path", siblings.length === 1 && siblings[0] === "Guide\n\nLinux\n\nRun the script.\n\nmacOS\n\nUse Homebrew.", siblings);
  const uncle = chunkDocument("# A\n\n## B\n\n### x\n\nshort x\n\n### y\n\nshort y\n\n## C\n\nshort c", MD);
  check("merged sections keep every heading once", uncle.length === 1 && uncle[0] === "A\n\nB\n\nx\n\nshort x\n\ny\n\nshort y\n\nC\n\nshort c", uncle);
  const between = chunkDocument("# A\n\nshort a\n\n## B\n\n### C\n\ntext c", MD);
  check("a heading with no body stays in the path of the one below it", between.length === 1 && between[0] === "A\n\nshort a\n\nB › C\n\ntext c", between);
  const changelog = chunkDocument("# Changelog\n\n## v2\n\n## v1\n\nFixed X.", MD);
  check("a heading with no body and nothing below it is kept", changelog.some((p) => p.includes("v2")), changelog);
  const longFence = "```yaml\n" + Array.from({ length: 60 }, (_, i) => `key${i}: value number ${i} for the zerops.yaml example`).join("\n") + "\n```";
  const fenced = chunkDocument(`# Config\n\n${longFence}`, MD);
  check("a long code block is not split", longFence.length > 1000 && fenced.some((p) => p.includes(longFence)), fenced.map((p) => p.length));
  const unclosed = chunkDocument(`# Config\n\n\`\`\`yaml\n${Array.from({ length: 80 }, (_, i) => `key${i}: value ${i}`).join("\n")}`, MD);
  check("an unclosed code block is split like text", unclosed.length >= 2 && unclosed.every((p) => p.length <= 1000 + "Config\n\n".length), unclosed.map((p) => p.length));
  const oneLine = chunkDocument(`# Data\n\n${"abcdefghij ".repeat(500)}`, MD);
  check("a long line without sentence ends is split", oneLine.length >= 5 && oneLine.every((p) => p.length <= 1000 + "Data\n\n".length), oneLine.map((p) => p.length));
  check("an underscore in a heading is kept", chunkDocument(`## ZEROPS_TOKEN\n\n${para("the token")}`, MD)[0].startsWith("ZEROPS_TOKEN\n\n"));
  check("a # at the end of a heading word is kept", chunkDocument(`# C#\n\n${para("C sharp")}`, MD)[0].startsWith("C#\n\n"));
  check("text without headings is split by paragraphs", JSON.stringify(chunkDocument(makeDoc("acme"), MD)) === JSON.stringify(chunkText(makeDoc("acme"))));
  const plain = "# not a heading in plain text\n\nSome notes.";
  check("plain text is split by paragraphs", JSON.stringify(chunkDocument(plain, "text/plain")) === JSON.stringify(chunkText(plain)));

  // ---- ingest A + B (shared word in both, tenant-unique doc) ----
  const da = await ingestDocument(A, "DOCTEST-acme.md", "text/markdown", makeDoc("acme"));
  const db = await ingestDocument(B, "DOCTEST-globex.md", "text/markdown", makeDoc("globex"));
  check("ingest returns a document with a chunk_count > 1", da.chunk_count > 1);
  check("document status is indexed", da.status === "indexed");

  // ---- retrieval: content deep in the doc is findable ----
  {
    const hits = await searchUntil(A, LATE);
    check("retrieval finds a chunk from a LATE paragraph (full-doc indexing)", hits.some((h) => h.text.includes(LATE) && h.document_id === da.id));
  }

  // ---- isolation on a shared word ----
  {
    const hits = await searchUntil(A, SHARED);
    check("shared-word retrieval returns own tenant's chunks", hits.some((h) => h.document_id === da.id));
    check("shared-word retrieval NEVER returns the other tenant's chunks", !hits.some((h) => h.document_id === db.id));
  }
  {
    const hits = await searchUntil(B, SHARED);
    check("globex retrieves its own chunks", hits.some((h) => h.document_id === db.id));
    check("globex never retrieves acme's chunks", !hits.some((h) => h.document_id === da.id));
  }

  // ---- raw content read (KB document viewer), tenant-scoped ----
  {
    const content = await getDocumentContent(A, da.id);
    check("getDocumentContent returns the raw stored text", !!content && content.content.includes(LATE));
    check("getDocumentContent carries filename + content type", content?.filename === "DOCTEST-acme.md" && content?.content_type === "text/markdown");
    check("A cannot read B's document content (cross-tenant → null)", (await getDocumentContent(A, db.id)) === null);
  }

  // ---- delete cascades chunks out of DB + index ----
  {
    check("delete own document → true", (await deleteDocument(A, da.id)) === true);
    check("deleted document get → null", (await getDocument(A, da.id)) === null);
    const remaining = await superPool.query("SELECT count(*)::int AS n FROM document_chunks WHERE document_id = $1", [da.id]);
    check("chunk rows cascade-deleted with the document", remaining.rows[0].n === 0);
    const stillIndexed = await searchDocuments(A, LATE);
    check("deleted document's chunks are no longer retrievable", !stillIndexed.some((h) => h.document_id === da.id));
  }

  // A cannot delete B's document
  check("A delete of B's document → false", (await deleteDocument(A, db.id)) === false);

  await clean();
  await superPool.end();
  await appPool.end();
  await relayPool.end();

  if (failures > 0) { console.error(`\nDOCUMENTS: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nDOCUMENTS: all checks green");
}

main().catch((e) => { console.error("documents seam ERROR", e); process.exit(1); });
