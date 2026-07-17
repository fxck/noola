import crypto from "node:crypto";
import { withTenant } from "@repo/db";
import { putText, getText } from "./storage.js";
import { extractText, isSupported, chunkText } from "./extract.js";
import { indexChunk, deleteDocChunks, searchChunkIds } from "./search.js";
import { embeddingDriver } from "./model.js";
import { upsertVectors, deleteVectorsByPayload } from "./vector.js";

// The document-ingestion pipeline: raw upload → object-storage → text extraction
// → chunking → chunk rows (RLS) → keyword index. The embedding/vector step is
// behind embeddingDriver (no-op default), so semantic retrieval slots in later
// without touching this flow. All tenant-scoped; chunks never cross tenants.

export interface DocumentRow {
  id: string;
  filename: string;
  content_type: string;
  char_count: number;
  chunk_count: number;
  status: string;
  source_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChunkHit {
  id: string;
  document_id: string;
  chunk_index: number;
  text: string;
}

const DOC_COLS = "id, filename, content_type, char_count, chunk_count, status, source_id, created_at, updated_at";

/** Ingest a supported text document end-to-end. Returns the stored document row.
 *  A sourceId links the doc to a live source (connector) so a re-sync can replace it. */
/** Optional source-sync bookkeeping so a re-crawl can diff instead of full-replace: `sourceKey` is
 *  the connector unit's stable id (page URL / repo path), `contentHash` is sha256 of its content. */
export interface IngestMeta { sourceKey?: string | null; contentHash?: string | null }

export async function ingestDocument(
  tenantId: string,
  filename: string,
  contentType: string,
  content: string,
  sourceId?: string | null,
  meta?: IngestMeta,
): Promise<DocumentRow> {
  if (!isSupported(contentType)) {
    throw Object.assign(new Error(`unsupported content type: ${contentType}`), { statusCode: 415 });
  }

  // 1. keep the raw upload in object-storage (re-extractable as the pipeline grows)
  const storageKey = `${tenantId}/docs/${crypto.randomUUID()}-${filename}`;
  await putText(storageKey, content, contentType);

  // 2. extract → 3. chunk
  const text = extractText(contentType, content);
  const chunks = chunkText(text);

  // 4. persist the document + its chunks in one tenant-scoped transaction
  const doc = await withTenant(tenantId, async (c) => {
    const d = await c.query(
      `INSERT INTO documents (tenant_id, filename, content_type, storage_key, char_count, chunk_count, source_id, source_key, content_hash)
       VALUES (current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${DOC_COLS}`,
      [filename, contentType, storageKey, text.length, chunks.length, sourceId ?? null, meta?.sourceKey ?? null, meta?.contentHash ?? null],
    );
    const row = d.rows[0] as DocumentRow;
    for (let i = 0; i < chunks.length; i++) {
      await c.query(
        `INSERT INTO document_chunks (tenant_id, document_id, chunk_index, text)
         VALUES (current_tenant(), $1, $2, $3)`,
        [row.id, i, chunks[i]],
      );
    }
    return row;
  });

  // 5. read the chunk ids back (RLS) and index them for retrieval
  const rows = await withTenant(tenantId, async (c) => {
    const r = await c.query(
      "SELECT id, chunk_index, text FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index",
      [doc.id],
    );
    return r.rows as Array<{ id: string; chunk_index: number; text: string }>;
  });
  // Index each chunk for keyword (Typesense) + vector (Qdrant) retrieval. Embedding
  // runs through the seam; a null result (embedder down) leaves keyword-only.
  const vecs = await embeddingDriver.embed(rows.map((r) => r.text));
  for (const r of rows) {
    await indexChunk({ id: r.id, tenant_id: tenantId, document_id: doc.id, chunk_index: r.chunk_index, text: r.text });
  }
  if (vecs) {
    await upsertVectors(
      "chunks",
      rows.map((r, i) => ({ id: r.id, vector: vecs[i], payload: { tenant_id: tenantId, document_id: doc.id } })),
    );
  }

  return doc;
}

/** Hydrate chunk ids through RLS, preserving order (double tenant guard for either
 *  ranker). Returns chunks with their document id for citation. */
export async function hydrateChunks(tenantId: string, ids: string[]): Promise<ChunkHit[]> {
  if (ids.length === 0) return [];
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT id, document_id, chunk_index, text FROM document_chunks
        WHERE id = ANY($1::uuid[]) ORDER BY array_position($1::uuid[], id)`,
      [ids],
    );
    return r.rows as ChunkHit[];
  });
}

export async function listDocuments(tenantId: string): Promise<DocumentRow[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(`SELECT ${DOC_COLS} FROM documents ORDER BY created_at DESC LIMIT 200`);
    return r.rows as DocumentRow[];
  });
}

export async function getDocument(tenantId: string, id: string): Promise<DocumentRow | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(`SELECT ${DOC_COLS} FROM documents WHERE id = $1`, [id]);
    return r.rowCount ? (r.rows[0] as DocumentRow) : null;
  });
}

export interface DocumentContent {
  filename: string;
  content_type: string;
  content: string;
}

/** Fetch a document's raw stored text (the original upload kept in object storage) for the
 *  KB document viewer. Tenant-scoped: the storage_key is read through RLS FIRST, so a
 *  cross-tenant id resolves to null before any storage read happens. */
export async function getDocumentContent(tenantId: string, id: string): Promise<DocumentContent | null> {
  const meta = await withTenant(tenantId, async (c) => {
    const r = await c.query(
      "SELECT filename, content_type, storage_key FROM documents WHERE id = $1",
      [id],
    );
    return r.rowCount
      ? (r.rows[0] as { filename: string; content_type: string; storage_key: string })
      : null;
  });
  if (!meta) return null;
  const content = await getText(meta.storage_key);
  return { filename: meta.filename, content_type: meta.content_type, content };
}

/** Clear a document's chunks out of the retrieval indexes (Typesense + Qdrant). The
 *  DB chunk rows are removed by ON DELETE CASCADE; the indexes have no FK, so we clear
 *  them explicitly. Shared by deleteDocument and deleteDocumentsBySource. */
async function clearDocIndexes(documentId: string): Promise<void> {
  await deleteDocChunks(documentId);
  await deleteVectorsByPayload("chunks", "document_id", documentId);
}

export async function deleteDocument(tenantId: string, id: string): Promise<boolean> {
  const gone = await withTenant(tenantId, async (c) => {
    // ON DELETE CASCADE removes the chunk rows; we clear the index separately.
    const r = await c.query("DELETE FROM documents WHERE id = $1", [id]);
    return (r.rowCount ?? 0) > 0;
  });
  if (gone) await clearDocIndexes(id);
  return gone;
}

/** Remove every document belonging to a source (tenant-scoped), clearing each one's
 *  keyword + vector index entries. This is the "re-sync replaces the source's docs"
 *  primitive: a sync deletes-by-source then re-ingests. Returns the count removed. */
export async function deleteDocumentsBySource(tenantId: string, sourceId: string): Promise<number> {
  const ids = await withTenant(tenantId, async (c) => {
    // Capture the ids first (RETURNING) so we know which index entries to clear;
    // chunk rows cascade with the document row inside this tenant-scoped delete.
    const r = await c.query("DELETE FROM documents WHERE source_id = $1 RETURNING id", [sourceId]);
    return r.rows.map((row) => row.id as string);
  });
  for (const id of ids) await clearDocIndexes(id);
  return ids.length;
}

export interface SyncUnit {
  key: string;
  title: string;
  contentType: string;
  content: string;
  /** "This key still exists upstream, keep the stored doc untouched" — lets an incremental
   *  connector skip expensive regeneration (e.g. model distillation) for unchanged units.
   *  content is ignored for keeps; a keep with no stored doc is dropped. */
  keep?: boolean;
}
export interface SyncDiff { added: number; updated: number; unchanged: number; removed: number; total: number }

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Incremental re-sync of a source's documents (replaces the old delete-all-then-reingest-all):
 * diff the freshly-fetched units against what's stored by `source_key` + `content_hash`, and only
 * touch what changed — re-embed + re-index the added/updated units, drop the removed ones, leave the
 * unchanged ones (and their expensive embeddings) alone. Also safer than the old path: it never
 * empties the source up-front, so a mid-sync failure leaves the last-good docs in place.
 *
 * First run after the 0085 upgrade: pre-hash docs have a null source_key → they're treated as
 * orphans and pruned, and every unit re-ingests with a key+hash (self-healing, one-time full cost).
 */
export async function syncDocuments(tenantId: string, sourceId: string, units: SyncUnit[]): Promise<SyncDiff> {
  const existing = await withTenant(tenantId, async (c) => {
    const r = await c.query("SELECT id, source_key, content_hash FROM documents WHERE source_id = $1", [sourceId]);
    return r.rows as Array<{ id: string; source_key: string | null; content_hash: string | null }>;
  });
  const byKey = new Map<string, { id: string; hash: string | null }>();
  const orphanIds: string[] = []; // null-keyed (pre-hash) or duplicate-keyed → prune
  for (const row of existing) {
    if (row.source_key && !byKey.has(row.source_key)) byKey.set(row.source_key, { id: row.id, hash: row.content_hash });
    else orphanIds.push(row.id);
  }

  const seen = new Set<string>();
  let added = 0, updated = 0, unchanged = 0;
  for (const u of units) {
    if (!u.key || seen.has(u.key)) continue; // ignore keyless / duplicate units
    seen.add(u.key);
    const ex = byKey.get(u.key);
    if (u.keep) { if (ex) unchanged++; continue; } // connector says unchanged — no hash, no re-embed
    const hash = hashContent(u.content);
    if (ex && ex.hash === hash) { unchanged++; continue; } // unchanged → keep as-is (no re-embed)
    try {
      if (ex) await deleteDocument(tenantId, ex.id); // changed → drop the old doc + its index entries
      await ingestDocument(tenantId, u.title || u.key, u.contentType, u.content, sourceId, { sourceKey: u.key, contentHash: hash });
      if (ex) updated++; else added++;
    } catch {
      // a single bad/unsupported unit must not fail the whole sync
    }
  }

  // Prune docs whose key vanished from the source, plus the pre-hash orphans.
  let removed = 0;
  for (const [key, ex] of byKey) if (!seen.has(key)) { await deleteDocument(tenantId, ex.id); removed++; }
  for (const id of orphanIds) { await deleteDocument(tenantId, id); removed++; }

  return { added, updated, unchanged, removed, total: unchanged + added + updated };
}

/**
 * Retrieve the passages most relevant to a query — the retrieval half of RAG.
 * Typesense ranks chunks (tenant filter_by), rows hydrate through RLS (double
 * tenant guard). Returns chunks with their document id for citation.
 */
export async function searchDocuments(tenantId: string, q: string): Promise<ChunkHit[]> {
  return hydrateChunks(tenantId, await searchChunkIds(tenantId, q));
}
