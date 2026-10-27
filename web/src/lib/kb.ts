import { api } from "@/lib/api";

// Knowledge Base client. Tenant is server-authoritative from the session token;
// these just carry the payload. Mirrors the api's KbArticle shape.

export interface KbArticle {
  id: string;
  title: string;
  body: string;
  /** The collection this article belongs to, or null = uncategorized. */
  collection_id: string | null;
  /** KB-CMS lifecycle. status: draft|published; visibility: internal (agent grounding only) | public
   *  (also on the help center). slug is the public URL key. Older rows may omit these. */
  status?: string;
  visibility?: string;
  slug?: string | null;
  published_at?: string | null;
  created_at: string;
  updated_at: string;
  /** Retrieval-index stats for the nerd surface — optional; older rows omit them. */
  chunk_count?: number;
  char_count?: number;
}

/** A partial article patch (title/body/collection + publish lifecycle). */
export interface KbArticlePatch {
  title?: string;
  body?: string;
  collection_id?: string | null;
  status?: "draft" | "published";
  visibility?: "internal" | "public";
}

/** A KB collection ("folder") grouping articles. `article_count` is present on list. */
export interface KbCollection {
  id: string;
  name: string;
  description: string;
  color: string;
  position: number;
  created_at: string;
  updated_at: string;
  article_count?: number;
}

export interface KbCollectionInput {
  name?: string;
  description?: string;
  color?: string;
  position?: number;
}

/** List articles. Pass a collection id to scope to it, or the sentinel "none" for
 *  uncategorized; omit for all (the UI groups by collection_id). */
export async function fetchArticles(collection?: string): Promise<KbArticle[]> {
  const qs = collection ? `?collection=${encodeURIComponent(collection)}` : "";
  return (await api<{ articles: KbArticle[] }>(`/kb${qs}`)).articles;
}
export async function searchArticles(q: string): Promise<KbArticle[]> {
  return (await api<{ articles: KbArticle[] }>(`/kb?q=${encodeURIComponent(q)}`)).articles;
}
export async function fetchArticle(id: string): Promise<KbArticle> {
  return (await api<{ article: KbArticle }>(`/kb/${id}`)).article;
}
export async function createArticle(
  title: string,
  body: string,
  collectionId?: string | null,
  opts?: { status?: "draft" | "published"; visibility?: "internal" | "public" },
): Promise<KbArticle> {
  const payload: KbArticlePatch = { title, body, ...opts };
  if (collectionId !== undefined) payload.collection_id = collectionId;
  return (await api<{ article: KbArticle }>("/kb", { method: "POST", body: JSON.stringify(payload) })).article;
}
/** Patch an article. Include `collection_id` (id or null) to move it between collections;
 *  omit the key to leave the collection unchanged. status/visibility drive the publish lifecycle. */
export async function updateArticle(id: string, patch: KbArticlePatch): Promise<KbArticle> {
  return (await api<{ article: KbArticle }>(`/kb/${id}`, { method: "PATCH", body: JSON.stringify(patch) })).article;
}
export async function deleteArticle(id: string): Promise<void> {
  await api(`/kb/${id}`, { method: "DELETE" });
}

// ---- Collections --------------------------------------------------------
export async function fetchCollections(): Promise<KbCollection[]> {
  return (await api<{ collections: KbCollection[] }>("/kb/collections")).collections;
}
export async function createCollection(input: KbCollectionInput): Promise<KbCollection> {
  return (await api<{ collection: KbCollection }>("/kb/collections", { method: "POST", body: JSON.stringify(input) })).collection;
}
export async function updateCollection(id: string, patch: KbCollectionInput): Promise<KbCollection> {
  return (await api<{ collection: KbCollection }>(`/kb/collections/${id}`, { method: "PATCH", body: JSON.stringify(patch) })).collection;
}
export async function deleteCollection(id: string): Promise<void> {
  await api(`/kb/collections/${id}`, { method: "DELETE" });
}
