import { api } from "@/lib/api";

// Public API keys — secret server-to-server credentials for the public API surface.
// The plaintext secret is returned once (on create) and never again.

export const API_SCOPES = ["answer", "tickets:read", "tickets:write"] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const SCOPE_LABELS: Record<ApiScope, string> = {
  answer: "Answer API — query the knowledge base",
  "tickets:read": "Read tickets",
  "tickets:write": "Create & update tickets",
};

export interface ApiKey {
  id: string;
  name: string | null;
  keyPrefix: string;
  scopes: string[];
  enabled: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

export async function fetchApiKeys(): Promise<ApiKey[]> {
  return (await api<{ keys: ApiKey[] }>("/api-keys")).keys;
}

export async function createApiKey(input: {
  name?: string;
  scopes: ApiScope[];
}): Promise<{ key: ApiKey; secret: string }> {
  return api<{ key: ApiKey; secret: string }>("/api-keys", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function revokeApiKey(id: string): Promise<void> {
  await api<{ ok: true }>(`/api-keys/${id}`, { method: "DELETE" });
}
