// API base. Every deployed rung injects VITE_API_URL from project env, so the fallback below is
// only for a bare `npm run dev` on a developer's machine — where the api is the one they are
// running locally. It previously pointed at https://apistage-561-*, a hostname in a DIFFERENT
// Zerops project that exists in no rung of this recipe: an unset var silently sent the session
// to someone else's backend. A production build still fails loud rather than guessing.
function resolveApiUrl(): string {
  const explicit = import.meta.env.VITE_API_URL as string | undefined;
  if (explicit) return explicit;
  if (import.meta.env.DEV) return "http://localhost:3000";
  throw new Error(
    "VITE_API_URL must be set for a production build — refusing to silently fall back to the stage backend.",
  );
}
const API_URL = resolveApiUrl();

const TOKEN_KEY = "noola.token";
let token: string | null = localStorage.getItem(TOKEN_KEY);

export function setToken(t: string | null): void {
  token = t;
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}
export function getToken(): string | null {
  return token;
}

export interface ApiError extends Error {
  status: number;
  /** The server's `{ error }` message when present (e.g. a 422's friendly reason). */
  detail?: string;
}

export async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...opts,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`) as ApiError;
    err.status = res.status;
    try {
      const body = await res.clone().json();
      if (body && typeof body.error === "string") err.detail = body.error;
    } catch { /* non-JSON error body — leave detail unset */ }
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export { API_URL };
