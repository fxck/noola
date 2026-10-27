import { API_URL } from "@/lib/api";

// Public help-center client. These endpoints are UNAUTHENTICATED and scoped by a widget key (the
// same key the Ask-AI widget uses), not a session — so they use a bare fetch to API_URL, never the
// Bearer `api()` helper. The server hard-filters to published+public articles.

export interface PublicArticle {
  slug: string;
  title: string;
  body: string;
  collection_id: string | null;
  collection_name: string | null;
  published_at: string | null;
  updated_at: string;
}

export interface PublicCollection {
  id: string;
  name: string;
  description: string;
  color: string;
  count: number;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`);
  if (!res.ok) throw Object.assign(new Error(`help ${res.status}`), { status: res.status });
  return (await res.json()) as T;
}

/** All published+public articles + the non-empty public collections for a workspace. */
export async function fetchHelpIndex(key: string, collection?: string): Promise<{ articles: PublicArticle[]; collections: PublicCollection[] }> {
  const q = collection ? `&collection=${encodeURIComponent(collection)}` : "";
  return get(`/public/kb?key=${encodeURIComponent(key)}${q}`);
}

export async function fetchHelpArticle(key: string, slug: string): Promise<PublicArticle> {
  const { article } = await get<{ article: PublicArticle }>(`/public/kb/${encodeURIComponent(slug)}?key=${encodeURIComponent(key)}`);
  return article;
}

export async function searchHelp(key: string, q: string): Promise<PublicArticle[]> {
  const { articles } = await get<{ articles: PublicArticle[] }>(`/public/kb/search?key=${encodeURIComponent(key)}&q=${encodeURIComponent(q)}`);
  return articles;
}

/** Support-form deflection: best-matching articles + an AI answer for a drafted question. */
export async function deflect(key: string, question: string): Promise<{ articles: PublicArticle[]; answer: { text: string; confidence: number | null } | null }> {
  const res = await fetch(`${API_URL}/public/deflect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, question }),
  });
  if (!res.ok) throw Object.assign(new Error(`deflect ${res.status}`), { status: res.status });
  return (await res.json()) as { articles: PublicArticle[]; answer: { text: string; confidence: number | null } | null };
}

/** Escalate to a human — files the drafted question as a ticket via the widget escalate lane. */
export async function escalateToTicket(key: string, question: string, conversationId: string): Promise<string | null> {
  const res = await fetch(`${API_URL}/public/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, question, conversationId, escalate: true }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { conversationId?: string };
  return data.conversationId ?? null;
}
