// Qdrant vector store via the HTTP API (no client dep, same discipline as search.ts).
// Tenant isolation is APP-ENFORCED: every search MUST filter on the tenant_id payload
// (Qdrant has no RLS), and the caller re-guards by hydrating hit ids through RLS.
// Vectors come from the self-hosted embedder (all-MiniLM, 384-dim, cosine).

import { relayPool } from "@repo/db";
import { embeddingDriver } from "./model.js";

const BASE = process.env.QDRANT_URL ?? "http://qdrant:6333";
const HEADERS: Record<string, string> = {
  "content-type": "application/json",
  ...(process.env.QDRANT_API_KEY ? { "api-key": process.env.QDRANT_API_KEY } : {}),
};

export const VECTOR_DIM = 384;
/** One collection per knowledge surface — mirrors the Typesense collections. */
export const COLLECTIONS = ["chunks", "kb", "threads"] as const;
export type VectorCollection = (typeof COLLECTIONS)[number];

/** True when a vector store is configured (env present). Lets every call no-op
 *  cleanly in tests / environments without Qdrant, degrading to keyword-only. */
export function vectorEnabled(): boolean {
  return Boolean(process.env.QDRANT_URL);
}

async function qdrant(path: string, method: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method,
    headers: HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Idempotently create a cosine collection of the right dimension. */
async function ensureCollection(name: string): Promise<void> {
  const head = await qdrant(`/collections/${name}`, "GET");
  if (head.ok) return;
  const res = await qdrant(`/collections/${name}`, "PUT", {
    vectors: { size: VECTOR_DIM, distance: "Cosine" },
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`qdrant create ${name} failed: ${res.status} ${await res.text()}`);
  }
  // Payload index on tenant_id makes the mandatory tenant filter fast.
  await qdrant(`/collections/${name}/index`, "PUT", {
    field_name: "tenant_id",
    field_schema: "keyword",
  }).catch(() => {});
}

export async function ensureVectorCollections(): Promise<void> {
  if (!vectorEnabled()) return;
  for (const c of COLLECTIONS) await ensureCollection(c);
}

export interface VectorPoint {
  id: string; // row id (chunk/article/ticket) — Qdrant accepts UUID strings
  vector: number[];
  payload: Record<string, string>; // MUST include tenant_id
}

/** Upsert points (fire-and-forget from the write path). No-op if disabled. */
export async function upsertVectors(collection: VectorCollection, points: VectorPoint[]): Promise<void> {
  if (!vectorEnabled() || points.length === 0) return;
  const res = await qdrant(`/collections/${collection}/points?wait=true`, "PUT", { points });
  if (!res.ok) throw new Error(`qdrant upsert ${collection} failed: ${res.status}`);
}

/** Tenant-scoped vector search → row ids in relevance order. The tenant filter is
 *  the index-layer isolation; callers still hydrate through RLS (double guard). */
export async function vectorSearch(
  collection: VectorCollection,
  tenantId: string,
  vector: number[],
  limit = 20,
  scoreThreshold?: number,
): Promise<string[]> {
  if (!vectorEnabled()) return [];
  const res = await qdrant(`/collections/${collection}/points/search`, "POST", {
    vector,
    limit,
    filter: { must: [{ key: "tenant_id", match: { value: tenantId } }] },
    with_payload: false,
    // Cosine floor: Qdrant otherwise returns the nearest neighbours regardless of how
    // far, so a gibberish query still "matches". A floor makes retrieval agreement
    // meaningful (the autoreply gate depends on it) and improves precision.
    ...(scoreThreshold !== undefined ? { score_threshold: scoreThreshold } : {}),
  });
  if (!res.ok) throw new Error(`qdrant search ${collection} failed: ${res.status}`);
  const raw = (await res.json()) as { result?: Array<{ id: string | number }> };
  return (raw.result ?? []).map((h) => String(h.id));
}

/** Delete points by id (row deletion). */
export async function deleteVectors(collection: VectorCollection, ids: string[]): Promise<void> {
  if (!vectorEnabled() || ids.length === 0) return;
  await qdrant(`/collections/${collection}/points/delete?wait=true`, "POST", { points: ids });
}

/** Delete every point matching a payload key (e.g. all chunks of a document). */
export async function deleteVectorsByPayload(
  collection: VectorCollection,
  key: string,
  value: string,
): Promise<void> {
  if (!vectorEnabled()) return;
  await qdrant(`/collections/${collection}/points/delete?wait=true`, "POST", {
    filter: { must: [{ key, match: { value } }] },
  });
}

async function pointCount(collection: string): Promise<number> {
  const res = await qdrant(`/collections/${collection}`, "GET");
  if (!res.ok) return 0;
  const j = (await res.json()) as { result?: { points_count?: number } };
  return j.result?.points_count ?? 0;
}

interface BackfillRow {
  tenant_id: string;
  id: string;
  text: string;
  document_id?: string;
}

async function backfill(
  collection: VectorCollection,
  rows: BackfillRow[],
  payloadOf: (r: BackfillRow) => Record<string, string>,
  log?: { warn?: (o: unknown, m?: string) => void },
): Promise<number> {
  for (let i = 0; i < rows.length; i += 64) {
    const batch = rows.slice(i, i + 64);
    const vecs = await embeddingDriver.embed(batch.map((b) => b.text));
    if (!vecs) {
      log?.warn?.({ collection }, "vector backfill aborted — embedder unavailable");
      return i;
    }
    await upsertVectors(collection, batch.map((b, j) => ({ id: b.id, vector: vecs[j], payload: payloadOf(b) })));
  }
  return rows.length;
}

/** Boot backfill: embed + index existing rows for any collection that's still empty
 *  (Qdrant persists, so this runs once). System-level reads via the BYPASSRLS relay;
 *  each point still carries its tenant_id payload for query-time isolation. */
export async function reindexAllVectors(
  log?: { info?: (m: string) => void; warn?: (o: unknown, m?: string) => void },
): Promise<void> {
  if (!vectorEnabled()) return;
  if ((await pointCount("chunks")) === 0) {
    const r = await relayPool.query("SELECT tenant_id, id, document_id, text FROM document_chunks");
    const n = await backfill("chunks", r.rows as BackfillRow[], (b) => ({ tenant_id: b.tenant_id, document_id: b.document_id ?? "" }), log);
    log?.info?.(`vectors: backfilled ${n} chunks`);
  }
  if ((await pointCount("kb")) === 0) {
    const r = await relayPool.query("SELECT tenant_id, id, (title || ' ' || body) AS text FROM kb_articles");
    const n = await backfill("kb", r.rows as BackfillRow[], (b) => ({ tenant_id: b.tenant_id }), log);
    log?.info?.(`vectors: backfilled ${n} kb`);
  }
  if ((await pointCount("threads")) === 0) {
    const r = await relayPool.query(
      `SELECT t.tenant_id, t.id,
              t.subject || ' ' || coalesce(string_agg(m.body, ' ' ORDER BY m.created_at), '') AS text
         FROM tickets t
         LEFT JOIN messages m ON m.tenant_id = t.tenant_id AND m.ticket_id = t.id
        WHERE t.status = 'closed'
        GROUP BY t.tenant_id, t.id, t.subject`,
    );
    const n = await backfill("threads", r.rows as BackfillRow[], (b) => ({ tenant_id: b.tenant_id }), log);
    log?.info?.(`vectors: backfilled ${n} threads`);
  }
}
