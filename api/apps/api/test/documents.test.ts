import pg from "pg";
import { appPool, relayPool } from "@repo/db";
import { ingestDocument, getDocument, getDocumentContent, deleteDocument, searchDocuments } from "../src/documents.js";
import { ensureChunksCollection } from "../src/search.js";
import { extractText, chunkText } from "../src/extract.js";

// Ingestion pipeline seam + isolation gate: a document is stored, extracted,
// chunked into MANY pieces, and every chunk is retrievable by content; the tenant
// filter_by + RLS keep one tenant's chunks out of another's; deleting a document
// cascades its chunks out of the DB and the index. Needs Typesense + Postgres.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const B = "22222222-2222-2222-2222-222222222222"; // Globex
const SHARED = "doczephyr";
const LATE = "quokkaparagraph"; // a word only in a LATE paragraph — proves full-doc chunking

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
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
