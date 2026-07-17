import { withTenant } from "@repo/db";
import { indexArticle, deleteArticleDoc, searchArticleIds } from "./search.js";
import { embeddingDriver } from "./model.js";
import { upsertVectors, deleteVectors } from "./vector.js";

// Knowledge Base module. Tenant-scoped CRUD through RLS (withTenant), with each
// write mirrored into Typesense for KB search. This is the substrate KB Copilot /
// RAG will read from later — behind the same isolation the rest of the app uses.

export interface KbArticle {
  id: string;
  title: string;
  body: string;
  collection_id: string | null;
  status: string;      // 'draft' | 'published'
  visibility: string;  // 'internal' | 'public'
  slug: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

const COLS = "id, title, body, collection_id, status, visibility, slug, published_at, created_at, updated_at";

/** A published, public article as the help center shows it — no internal/draft fields leak. */
export interface PublicArticle {
  slug: string;
  title: string;
  body: string;
  collection_id: string | null;
  collection_name: string | null;
  published_at: string | null;
  updated_at: string;
}

const PUBLIC_COLS =
  "a.slug, a.title, a.body, a.collection_id, c.name AS collection_name, a.published_at, a.updated_at";

/** Slugify a title into a URL key (lowercase, hyphenated, trimmed). Empty → "article". */
export function slugify(title: string): string {
  const s = (title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return s || "article";
}

/** A slug unique within the tenant — appends -2, -3, … on collision (excluding `excludeId`). */
async function uniqueSlug(c: { query: (q: string, p?: unknown[]) => Promise<{ rowCount: number | null }> }, base: string, excludeId?: string): Promise<string> {
  let slug = base;
  for (let n = 1; n < 200; n++) {
    const r = await c.query(
      `SELECT 1 FROM kb_articles WHERE slug = $1 ${excludeId ? "AND id <> $2" : ""} LIMIT 1`,
      excludeId ? [slug, excludeId] : [slug],
    );
    if (!r.rowCount) return slug;
    slug = `${base}-${n + 1}`;
  }
  return `${base}-${Date.now()}`;
}

export interface KbCollection {
  id: string;
  name: string;
  description: string;
  color: string;
  position: number;
  created_at: string;
  updated_at: string;
}

const COLLECTION_COLS = "id, name, description, color, position, created_at, updated_at";

/** Mirror an article into both indexes — Typesense (keyword) + Qdrant (vector) —
 *  best-effort, outside any txn. Embedding failure degrades to keyword-only. */
async function reindex(tenantId: string, a: KbArticle): Promise<void> {
  await indexArticle({
    id: a.id,
    tenant_id: tenantId,
    title: a.title,
    body: a.body,
    updated_at: Math.floor(new Date(a.updated_at).getTime() / 1000),
  });
  const vecs = await embeddingDriver.embed([`${a.title}\n${a.body}`]);
  if (vecs) await upsertVectors("kb", [{ id: a.id, vector: vecs[0], payload: { tenant_id: tenantId } }]);
}

/** Hydrate article ids through RLS, preserving the given id order (double tenant
 *  guard for either ranker — Typesense or Qdrant). */
export async function hydrateArticles(tenantId: string, ids: string[]): Promise<KbArticle[]> {
  if (ids.length === 0) return [];
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT ${COLS} FROM kb_articles WHERE id = ANY($1::uuid[]) ORDER BY array_position($1::uuid[], id)`,
      [ids],
    );
    return r.rows as KbArticle[];
  });
}

export async function createArticle(
  tenantId: string,
  title: string,
  body: string,
  collectionId?: string | null,
  opts?: { status?: string; visibility?: string },
): Promise<KbArticle> {
  const status = opts?.status === "draft" ? "draft" : "published";
  const visibility = opts?.visibility === "public" ? "public" : "internal";
  const a = await withTenant(tenantId, async (c) => {
    const slug = await uniqueSlug(c, slugify(title));
    const r = await c.query(
      `INSERT INTO kb_articles (tenant_id, title, body, collection_id, status, visibility, slug, published_at)
       VALUES (current_tenant(), $1, $2, $3, $4, $5, $6, CASE WHEN $4 = 'published' THEN now() ELSE NULL END)
       RETURNING ${COLS}`,
      [title, body, collectionId ?? null, status, visibility, slug],
    );
    return r.rows[0] as KbArticle;
  });
  await reindex(tenantId, a);
  return a;
}

/** List articles, optionally scoped to one collection. `collectionId === null` returns
 *  only uncategorized articles; a string returns that collection; undefined returns all
 *  (the UI groups them by collection_id). Newest-touched first. */
export async function listArticles(
  tenantId: string,
  collectionId?: string | null,
): Promise<KbArticle[]> {
  return withTenant(tenantId, async (c) => {
    if (collectionId === null) {
      const r = await c.query(
        `SELECT ${COLS} FROM kb_articles WHERE collection_id IS NULL ORDER BY updated_at DESC LIMIT 200`,
      );
      return r.rows as KbArticle[];
    }
    if (typeof collectionId === "string") {
      const r = await c.query(
        `SELECT ${COLS} FROM kb_articles WHERE collection_id = $1 ORDER BY updated_at DESC LIMIT 200`,
        [collectionId],
      );
      return r.rows as KbArticle[];
    }
    const r = await c.query(`SELECT ${COLS} FROM kb_articles ORDER BY updated_at DESC LIMIT 200`);
    return r.rows as KbArticle[];
  });
}

export async function getArticle(tenantId: string, id: string): Promise<KbArticle | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(`SELECT ${COLS} FROM kb_articles WHERE id = $1`, [id]);
    return r.rowCount ? (r.rows[0] as KbArticle) : null;
  });
}

/** Update title/body/collection (partial). For collection_id, an explicit key (string or
 *  null) is applied; an absent key leaves the current collection unchanged — so an article
 *  can be moved into a collection or back to uncategorized (null). Returns null if the
 *  article isn't in this tenant. */
export async function updateArticle(
  tenantId: string,
  id: string,
  patch: { title?: string; body?: string; collection_id?: string | null; status?: string; visibility?: string },
): Promise<KbArticle | null> {
  const setCollection = Object.prototype.hasOwnProperty.call(patch, "collection_id");
  const status = patch.status === "draft" || patch.status === "published" ? patch.status : null;
  const visibility = patch.visibility === "internal" || patch.visibility === "public" ? patch.visibility : null;
  const a = await withTenant(tenantId, async (c) => {
    // First publish stamps published_at; unpublish clears it. COALESCE keeps it stable otherwise.
    const r = await c.query(
      `UPDATE kb_articles
          SET title = COALESCE($2, title),
              body  = COALESCE($3, body),
              collection_id = CASE WHEN $4 THEN $5 ELSE collection_id END,
              status = COALESCE($6, status),
              visibility = COALESCE($7, visibility),
              published_at = CASE
                WHEN $6 = 'published' AND published_at IS NULL THEN now()
                WHEN $6 = 'draft' THEN NULL
                ELSE published_at END,
              updated_at = now()
        WHERE id = $1
      RETURNING ${COLS}`,
      [id, patch.title ?? null, patch.body ?? null, setCollection, patch.collection_id ?? null, status, visibility],
    );
    return r.rowCount ? (r.rows[0] as KbArticle) : null;
  });
  if (a) await reindex(tenantId, a);
  return a;
}

// ---- Public help-center surface -------------------------------------------
// The published + public subset of the KB, served on the unauthenticated help center. Every function
// here hard-filters `status = 'published' AND visibility = 'public'` so a draft or internal article
// can never leak. Tenant is resolved from a widget key BEFORE these run (pre-context), then passed in.

/** Published, public articles for the help center, newest-published first, with collection name. */
export async function listPublicArticles(tenantId: string, collectionId?: string): Promise<PublicArticle[]> {
  return withTenant(tenantId, async (c) => {
    const params: unknown[] = [];
    let filter = "";
    if (collectionId) { params.push(collectionId); filter = `AND a.collection_id = $${params.length}`; }
    const r = await c.query(
      `SELECT ${PUBLIC_COLS}
         FROM kb_articles a
         LEFT JOIN kb_collections c ON c.id = a.collection_id AND c.tenant_id = a.tenant_id
        WHERE a.status = 'published' AND a.visibility = 'public' ${filter}
        ORDER BY a.published_at DESC NULLS LAST, a.updated_at DESC
        LIMIT 500`,
      params,
    );
    return r.rows as PublicArticle[];
  });
}

/** The public collections that actually contain a published+public article (empty ones are hidden). */
export async function listPublicCollections(tenantId: string): Promise<{ id: string; name: string; description: string; color: string; count: number }[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT col.id, col.name, col.description, col.color, count(a.id)::int AS count
         FROM kb_collections col
         JOIN kb_articles a ON a.collection_id = col.id AND a.tenant_id = col.tenant_id
          AND a.status = 'published' AND a.visibility = 'public'
        GROUP BY col.id, col.name, col.description, col.color, col.position
        ORDER BY col.position, col.name`,
    );
    return r.rows as { id: string; name: string; description: string; color: string; count: number }[];
  });
}

/** One public article by slug, or null if it isn't published+public. */
export async function getPublicArticleBySlug(tenantId: string, slug: string): Promise<PublicArticle | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT ${PUBLIC_COLS}
         FROM kb_articles a
         LEFT JOIN kb_collections c ON c.id = a.collection_id AND c.tenant_id = a.tenant_id
        WHERE a.slug = $1 AND a.status = 'published' AND a.visibility = 'public' LIMIT 1`,
      [slug],
    );
    return r.rowCount ? (r.rows[0] as PublicArticle) : null;
  });
}

/** Search the public subset: Typesense ranks, then re-filter to published+public by slug through RLS. */
export async function searchPublicArticles(tenantId: string, q: string): Promise<PublicArticle[]> {
  const ids = await searchArticleIds(tenantId, q);
  if (ids.length === 0) return [];
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT ${PUBLIC_COLS}
         FROM kb_articles a
         LEFT JOIN kb_collections c ON c.id = a.collection_id AND c.tenant_id = a.tenant_id
        WHERE a.id = ANY($1::uuid[]) AND a.status = 'published' AND a.visibility = 'public'
        ORDER BY array_position($1::uuid[], a.id)
        LIMIT 20`,
      [ids],
    );
    return r.rows as PublicArticle[];
  });
}

export async function deleteArticle(tenantId: string, id: string): Promise<boolean> {
  const gone = await withTenant(tenantId, async (c) => {
    const r = await c.query("DELETE FROM kb_articles WHERE id = $1", [id]);
    return (r.rowCount ?? 0) > 0;
  });
  if (gone) {
    await deleteArticleDoc(id);
    await deleteVectors("kb", [id]);
  }
  return gone;
}

/** Full-text KB search: Typesense ranks (title+body, tenant filter_by), then rows
 *  hydrate through RLS — the same double tenant guard as ticket search. */
export async function searchArticles(tenantId: string, q: string): Promise<KbArticle[]> {
  return hydrateArticles(tenantId, await searchArticleIds(tenantId, q));
}

// ---- Collections (KB taxonomy) --------------------------------------------
// A tenant-scoped grouping ("folder") over articles. Articles carry an optional
// collection_id (ON DELETE SET NULL) so removing a collection never deletes articles —
// they fall back to uncategorized. Collections don't touch the retrieval indexes.

/** List collections, each with a live article count (uncategorized isn't a row — the UI
 *  derives it from articles with collection_id IS NULL). Ordered by position then name. */
export async function listCollections(
  tenantId: string,
): Promise<Array<KbCollection & { article_count: number }>> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT ${COLLECTION_COLS.split(", ").map((c2) => `col.${c2}`).join(", ")},
              count(a.id)::int AS article_count
         FROM kb_collections col
         LEFT JOIN kb_articles a ON a.collection_id = col.id AND a.tenant_id = col.tenant_id
        GROUP BY col.id, col.name, col.description, col.color, col.position, col.created_at, col.updated_at
        ORDER BY col.position ASC, lower(col.name) ASC`,
    );
    return r.rows as Array<KbCollection & { article_count: number }>;
  });
}

export async function getCollection(tenantId: string, id: string): Promise<KbCollection | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(`SELECT ${COLLECTION_COLS} FROM kb_collections WHERE id = $1`, [id]);
    return r.rowCount ? (r.rows[0] as KbCollection) : null;
  });
}

export async function createCollection(
  tenantId: string,
  input: { name: string; description?: string; color?: string; position?: number },
): Promise<KbCollection> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO kb_collections (tenant_id, name, description, color, position)
       VALUES (current_tenant(), $1, COALESCE($2,''), COALESCE($3,''), COALESCE($4,0))
       RETURNING ${COLLECTION_COLS}`,
      [input.name, input.description ?? null, input.color ?? null, input.position ?? null],
    );
    return r.rows[0] as KbCollection;
  });
}

/** Partial update of a collection (name/description/color/position). Returns null if gone. */
export async function updateCollection(
  tenantId: string,
  id: string,
  patch: { name?: string; description?: string; color?: string; position?: number },
): Promise<KbCollection | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `UPDATE kb_collections
          SET name = COALESCE($2, name),
              description = COALESCE($3, description),
              color = COALESCE($4, color),
              position = COALESCE($5, position),
              updated_at = now()
        WHERE id = $1
      RETURNING ${COLLECTION_COLS}`,
      [id, patch.name ?? null, patch.description ?? null, patch.color ?? null, patch.position ?? null],
    );
    return r.rowCount ? (r.rows[0] as KbCollection) : null;
  });
}

/** Delete a collection; its articles fall back to uncategorized (FK ON DELETE SET NULL).
 *  Returns false if the collection wasn't in this tenant. */
export async function deleteCollection(tenantId: string, id: string): Promise<boolean> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query("DELETE FROM kb_collections WHERE id = $1", [id]);
    return (r.rowCount ?? 0) > 0;
  });
}
