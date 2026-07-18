// API base. A production build MUST inject VITE_API_URL (prod api origin); the dev/stage
// convenience fallback to the durable stage api is scoped to `import.meta.env.DEV` so a prod
// build can never silently ship talking to stage — it fails loud instead (a separate prod
// project has no apistage-561 host). Stage builds set VITE_API_URL explicitly (zerops.yaml).
function resolveApiUrl(): string {
  const explicit = import.meta.env.VITE_API_URL as string | undefined;
  if (explicit) return explicit;
  if (import.meta.env.DEV) return "https://apistage-561-3000.prg1.zerops.app";
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
