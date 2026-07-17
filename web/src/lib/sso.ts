import { api, API_URL } from "@/lib/api";

// Enterprise SSO — per-tenant OIDC/SAML connections (admin config) + a public, session-less
// discovery lane the login page uses to route a user to their IdP by email domain.

export type SsoProvider = "oidc" | "saml";

export interface SsoConnection {
  id: string;
  provider: SsoProvider;
  name: string;
  email_domain: string;
  issuer: string | null;
  authorize_url: string | null;
  token_url: string | null;
  jwks_url: string | null;
  client_id: string | null;
  has_secret: boolean;
  enabled: boolean;
  created_at: string;
}

export interface SsoConnectionInput {
  provider?: SsoProvider;
  name: string;
  emailDomain: string;
  issuer?: string | null;
  authorizeUrl?: string | null;
  tokenUrl?: string | null;
  jwksUrl?: string | null;
  clientId?: string | null;
  clientSecret?: string | null;
  enabled?: boolean;
}

export async function fetchSsoConnections(): Promise<SsoConnection[]> {
  return (await api<{ connections: SsoConnection[] }>("/sso-connections")).connections;
}

export async function createSsoConnection(input: SsoConnectionInput): Promise<SsoConnection> {
  return (await api<{ connection: SsoConnection }>("/sso-connections", { method: "POST", body: JSON.stringify(input) })).connection;
}

export async function updateSsoConnection(id: string, patch: Partial<SsoConnectionInput>): Promise<SsoConnection> {
  return (await api<{ connection: SsoConnection }>(`/sso-connections/${id}`, { method: "PATCH", body: JSON.stringify(patch) })).connection;
}

export async function deleteSsoConnection(id: string): Promise<void> {
  await api<{ ok: true }>(`/sso-connections/${id}`, { method: "DELETE" });
}

// ── Public discovery (no session) ──
export interface SsoDiscovery {
  sso: boolean;
  provider?: SsoProvider;
  name?: string;
  connectionId?: string;
}

export async function discoverSso(email: string): Promise<SsoDiscovery> {
  const r = await fetch(`${API_URL}/public/sso/discover?email=${encodeURIComponent(email)}`);
  if (!r.ok) return { sso: false };
  return (await r.json()) as SsoDiscovery;
}

/** Full-page navigate to begin the IdP handoff. */
export function startSso(connectionId: string): void {
  window.location.href = `${API_URL}/public/sso/start?connectionId=${encodeURIComponent(connectionId)}`;
}
