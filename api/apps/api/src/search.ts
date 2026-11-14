// Typesense wiring via the HTTP API (no client dep). Tenant isolation is
// APP-ENFORCED here — Typesense has no RLS, so every query MUST filter_by
// tenant_id. That mandatory filter is the seam the product's search sits behind
// (and the /search route double-guards by hydrating the hit rows through RLS).

import { relayPool } from "@repo/db";

const BASE = `http://${process.env.SEARCH_HOST}:${process.env.SEARCH_PORT}`;
const HEADERS = {
  "x-typesense-api-key": process.env.SEARCH_API_KEY ?? "",
  "content-type": "application/json",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TicketDoc {
  id: string;
  tenant_id: string;
  subject: string;
  body: string;
  created_at: number; // unix seconds
}

/** Idempotently create the tickets collection. */
export async function ensureTicketsCollection(): Promise<void> {
  const head = await fetch(`${BASE}/collections/tickets`, { headers: HEADERS });
  if (head.ok) return;
  const res = await fetch(`${BASE}/collections`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      name: "tickets",
      fields: [
        { name: "tenant_id", type: "string", facet: true },
        { name: "subject", type: "string" },
        { name: "body", type: "string" },
        { name: "created_at", type: "int64" },
      ],
      default_sorting_field: "created_at",
    }),
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`typesense create collection failed: ${res.status} ${await res.text()}`);
  }
}

/** Upsert a ticket document (fire-and-forget from the request path). */
export async function indexTicket(doc: TicketDoc): Promise<void> {
  const res = await fetch(`${BASE}/collections/tickets/documents?action=upsert`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(doc),
  });
  if (!res.ok) throw new Error(`typesense index failed: ${res.status}`);
}

/** Remove a ticket doc from the index (ticket deletion / test teardown). */
export async function deleteTicketDoc(id: string): Promise<void> {
  await fetch(`${BASE}/collections/tickets/documents/${id}`, { method: "DELETE", headers: HEADERS });
}

// ---- Knowledge Base collection (same tenant-isolation discipline) --------

export interface ArticleDoc {
  id: string;
  tenant_id: string;
  title: string;
  body: string;
  updated_at: number; // unix seconds
}

/** Idempotently create the kb collection. */
export async function ensureKbCollection(): Promise<void> {
  const head = await fetch(`${BASE}/collections/kb`, { headers: HEADERS });
  if (head.ok) return;
  const res = await fetch(`${BASE}/collections`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      name: "kb",
      fields: [
        { name: "tenant_id", type: "string", facet: true },
        { name: "title", type: "string" },
        { name: "body", type: "string" },
        { name: "updated_at", type: "int64" },
      ],
      default_sorting_field: "updated_at",
    }),
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`typesense create kb collection failed: ${res.status} ${await res.text()}`);
  }
}

/** Upsert a KB article document. */
export async function indexArticle(doc: ArticleDoc): Promise<void> {
  const res = await fetch(`${BASE}/collections/kb/documents?action=upsert`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(doc),
  });
  if (!res.ok) throw new Error(`typesense kb index failed: ${res.status}`);
}

/** Remove a KB doc from the index (article deletion / test teardown). */
export async function deleteArticleDoc(id: string): Promise<void> {
  await fetch(`${BASE}/collections/kb/documents/${id}`, { method: "DELETE", headers: HEADERS });
}

/** Tenant-scoped KB full-text search over title+body. Returns article ids in
 *  relevance order — the mandatory filter_by is the index-layer isolation. */
export async function searchArticleIds(tenantId: string, q: string): Promise<string[]> {
  if (!UUID_RE.test(tenantId)) throw new Error("invalid tenant");
  const params = new URLSearchParams({
    q: q || "*",
    query_by: "title,body",
    filter_by: `tenant_id:=${tenantId}`,
    per_page: "50",
  });
  const res = await fetch(`${BASE}/collections/kb/documents/search?${params}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`typesense kb search failed: ${res.status}`);
  const raw = (await res.json()) as { hits?: Array<{ document: ArticleDoc }> };
  return (raw.hits ?? []).map((h) => h.document.id);
}

// ---- Retrieval keyword search -------------------------------------------

export type RetrievalCollection = "kb" | "chunks" | "threads";

const RETRIEVAL_FIELDS: Record<RetrievalCollection, string> = { kb: "title,body", chunks: "text", threads: "subject,text" };

/** A keyword hit, with how many query words it matched and Typesense's match score. */
export interface KeywordHit {
  id: string;
  words: number;
  score: number;
}

/**
 * Tenant-scoped keyword hits for answer retrieval.
 * Typesense drops query words from the end until it has `limit` hits, so a hit may match only the leading words.
 * The caller decides how many must match.
 */
export async function keywordHits(collection: RetrievalCollection, tenantId: string, q: string, limit = 20): Promise<KeywordHit[]> {
  if (!UUID_RE.test(tenantId)) throw new Error("invalid tenant");
  const params = new URLSearchParams({
    q,
    query_by: RETRIEVAL_FIELDS[collection],
    filter_by: `tenant_id:=${tenantId}`,
    per_page: String(limit),
    drop_tokens_threshold: String(limit),
    include_fields: "id",
  });
  const res = await fetch(`${BASE}/collections/${collection}/documents/search?${params}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`typesense ${collection} search failed: ${res.status}`);
  const raw = (await res.json()) as {
    hits?: Array<{ document: { id: string }; text_match?: number; text_match_info?: { tokens_matched?: number } }>;
  };
  return (raw.hits ?? []).map((h) => ({ id: h.document.id, words: h.text_match_info?.tokens_matched ?? 0, score: Number(h.text_match ?? 0) }));
}

// ---- Document chunks collection (retrieval unit for ingested docs) -------

export interface ChunkDoc {
  id: string;
  tenant_id: string;
  document_id: string;
  chunk_index: number;
  text: string;
}

export async function ensureChunksCollection(): Promise<void> {
  const head = await fetch(`${BASE}/collections/chunks`, { headers: HEADERS });
  if (head.ok) return;
  const res = await fetch(`${BASE}/collections`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      name: "chunks",
      fields: [
        { name: "tenant_id", type: "string", facet: true },
        { name: "document_id", type: "string", facet: true },
        { name: "chunk_index", type: "int32" },
        { name: "text", type: "string" },
      ],
    }),
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`typesense create chunks collection failed: ${res.status} ${await res.text()}`);
  }
}

export async function indexChunk(doc: ChunkDoc): Promise<void> {
  const res = await fetch(`${BASE}/collections/chunks/documents?action=upsert`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(doc),
  });
  if (!res.ok) throw new Error(`typesense chunk index failed: ${res.status}`);
}

/** Remove chunks from the keyword index by id. A missing chunk is no error. */
export async function deleteChunkDocs(ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 20) {
    await Promise.all(ids.slice(i, i + 20).map(async (id) => {
      const res = await fetch(`${BASE}/collections/chunks/documents/${encodeURIComponent(id)}`, { method: "DELETE", headers: HEADERS });
      if (!res.ok && res.status !== 404) throw new Error(`typesense chunk delete failed: ${res.status}`);
    }));
  }
}

/** Delete every indexed chunk of a document (document deletion). */
export async function deleteDocChunks(documentId: string): Promise<void> {
  await fetch(`${BASE}/collections/chunks/documents?filter_by=document_id:=${documentId}`, {
    method: "DELETE",
    headers: HEADERS,
  });
}

/** Tenant-scoped chunk retrieval over text. Returns chunk ids in relevance order —
 *  the filter_by is the index-layer isolation (rows re-guard through RLS). */
export async function searchChunkIds(tenantId: string, q: string): Promise<string[]> {
  if (!UUID_RE.test(tenantId)) throw new Error("invalid tenant");
  const params = new URLSearchParams({
    q: q || "*",
    query_by: "text",
    filter_by: `tenant_id:=${tenantId}`,
    per_page: "20",
  });
  const res = await fetch(`${BASE}/collections/chunks/documents/search?${params}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`typesense chunk search failed: ${res.status}`);
  const raw = (await res.json()) as { hits?: Array<{ document: ChunkDoc }> };
  return (raw.hits ?? []).map((h) => h.document.id);
}

// The advisory lock that the chunk backfills and the document re-split take, across all api processes.
const CHUNK_INDEX_LOCK = 72_503_101;

/**
 * Run `fn` while no other api process backfills chunks or re-splits documents.
 * A backfill reads every chunk row first, so it could re-index passages that a re-split just replaced.
 * The lock is session-level, so it needs a direct connection, not a transaction pooler.
 */
export async function withChunkIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const c = await relayPool.connect();
  let broken = false;
  // A dropped connection releases the lock, and without a listener its error would crash the process.
  const onError = () => { broken = true; };
  c.on("error", onError);
  try {
    await c.query("SELECT pg_advisory_lock($1)", [CHUNK_INDEX_LOCK]);
    return await fn();
  } finally {
    if (!broken) await c.query("SELECT pg_advisory_unlock($1)", [CHUNK_INDEX_LOCK]).catch(() => { broken = true; });
    c.off("error", onError);
    c.release(broken);
  }
}

/** Backfill: index every existing chunk (via the BYPASSRLS relay). */
export async function reindexAllChunks(
  log?: { info: (m: string) => void; warn: (o: unknown, m?: string) => void },
): Promise<number> {
  return withChunkIndexLock(() => indexEveryChunk(log));
}

async function indexEveryChunk(log?: { info: (m: string) => void; warn: (o: unknown, m?: string) => void }): Promise<number> {
  const r = await relayPool.query(
    `SELECT tenant_id, id, document_id, chunk_index, text FROM document_chunks`,
  );
  let n = 0;
  for (const row of r.rows as ChunkDoc[]) {
    try {
      await indexChunk({ id: row.id, tenant_id: row.tenant_id, document_id: row.document_id, chunk_index: row.chunk_index, text: row.text });
      n++;
    } catch (err) {
      log?.warn?.({ err, id: row.id }, "reindex chunk failed");
    }
  }
  log?.info?.(`search: reindexed ${n} document chunks`);
  return n;
}

/** Backfill: index every existing KB article (via the BYPASSRLS relay). */
export async function reindexAllArticles(
  log?: { info: (m: string) => void; warn: (o: unknown, m?: string) => void },
): Promise<number> {
  const r = await relayPool.query(
    `SELECT tenant_id, id, title, body, extract(epoch FROM updated_at)::bigint AS updated_at FROM kb_articles`,
  );
  let n = 0;
  for (const row of r.rows as Array<ArticleDoc & { updated_at: string | number }>) {
    try {
      await indexArticle({ id: row.id, tenant_id: row.tenant_id, title: row.title, body: row.body, updated_at: Number(row.updated_at) });
      n++;
    } catch (err) {
      log?.warn?.({ err, id: row.id }, "reindex article failed");
    }
  }
  log?.info?.(`search: reindexed ${n} kb articles`);
  return n;
}

/** Tenant-scoped full-text search over subject+body. Returns the matching ticket
 *  ids in relevance order. The filter_by is non-negotiable — it is the isolation
 *  at the index layer (the row hydration re-checks it through RLS). */
export async function searchTicketIds(tenantId: string, q: string): Promise<string[]> {
  if (!UUID_RE.test(tenantId)) throw new Error("invalid tenant");
  const params = new URLSearchParams({
    q: q || "*",
    query_by: "subject,body",
    filter_by: `tenant_id:=${tenantId}`,
    per_page: "50",
  });
  const res = await fetch(`${BASE}/collections/tickets/documents/search?${params}`, {
    headers: HEADERS,
  });
  if (!res.ok) throw new Error(`typesense search failed: ${res.status}`);
  const raw = (await res.json()) as { hits?: Array<{ document: TicketDoc }> };
  return (raw.hits ?? []).map((h) => h.document.id);
}

// ---- Resolved-threads collection (past conversations as a knowledge source) ----
// A closed ticket's thread (subject + Q&A) is indexed here so Copilot can retrieve
// how the team already answered a similar question. Same tenant-isolation discipline
// (mandatory filter_by), and retrieval double-guards by hydrating through RLS.

export interface ThreadDoc {
  id: string; // ticket id
  tenant_id: string;
  subject: string;
  text: string; // subject + the message exchange
  closed_at: number; // unix seconds
}

export async function ensureThreadsCollection(): Promise<void> {
  const head = await fetch(`${BASE}/collections/threads`, { headers: HEADERS });
  if (head.ok) return;
  const res = await fetch(`${BASE}/collections`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      name: "threads",
      fields: [
        { name: "tenant_id", type: "string", facet: true },
        { name: "subject", type: "string" },
        { name: "text", type: "string" },
        { name: "closed_at", type: "int64" },
      ],
      default_sorting_field: "closed_at",
    }),
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`typesense create threads collection failed: ${res.status} ${await res.text()}`);
  }
}

export async function indexThreadDoc(doc: ThreadDoc): Promise<void> {
  const res = await fetch(`${BASE}/collections/threads/documents?action=upsert`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(doc),
  });
  if (!res.ok) throw new Error(`typesense thread index failed: ${res.status}`);
}

/** Remove a thread doc (ticket reopened / deleted). */
export async function deleteThreadDoc(id: string): Promise<void> {
  await fetch(`${BASE}/collections/threads/documents/${id}`, { method: "DELETE", headers: HEADERS });
}

export async function searchThreadIds(tenantId: string, q: string): Promise<string[]> {
  if (!UUID_RE.test(tenantId)) throw new Error("invalid tenant");
  const params = new URLSearchParams({
    q: q || "*",
    query_by: "subject,text",
    filter_by: `tenant_id:=${tenantId}`,
    per_page: "20",
  });
  const res = await fetch(`${BASE}/collections/threads/documents/search?${params}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`typesense thread search failed: ${res.status}`);
  const raw = (await res.json()) as { hits?: Array<{ document: ThreadDoc }> };
  return (raw.hits ?? []).map((h) => h.document.id);
}

/** Backfill: index every existing ticket (subject + all its message bodies) so
 *  tickets created before indexing — seeds, demos, pre-search history — are
 *  searchable. Reads across tenants via the BYPASSRLS relay (system-level op),
 *  and each doc still carries its own tenant_id for query-time isolation. */
export async function reindexAllTickets(
  log?: { info: (m: string) => void; warn: (o: unknown, m?: string) => void },
): Promise<number> {
  const r = await relayPool.query(
    `SELECT t.tenant_id, t.id, t.subject,
            coalesce(string_agg(m.body, ' ' ORDER BY m.created_at), '') AS body,
            extract(epoch FROM t.created_at)::bigint AS created_at
       FROM tickets t
       LEFT JOIN messages m ON m.tenant_id = t.tenant_id AND m.ticket_id = t.id
      GROUP BY t.tenant_id, t.id, t.subject, t.created_at`,
  );
  let n = 0;
  for (const row of r.rows as Array<TicketDoc & { created_at: string | number }>) {
    try {
      await indexTicket({
        id: row.id,
        tenant_id: row.tenant_id,
        subject: row.subject,
        body: row.body,
        created_at: Number(row.created_at),
      });
      n++;
    } catch (err) {
      log?.warn?.({ err, id: row.id }, "reindex ticket failed");
    }
  }
  log?.info?.(`search: reindexed ${n} tickets`);
  return n;
}
