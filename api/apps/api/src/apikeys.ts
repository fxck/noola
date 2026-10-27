import crypto from "node:crypto";
import { relayPool } from "@repo/db";
import { API_SCOPES } from "@repo/contracts";

// Public API keys — SECRET server-to-server keys (sk_...) for the public API surface.
// Stored HASHED (sha256); the plaintext is returned exactly once, at creation. Resolved
// pre-tenant on the BYPASSRLS relay pool (like widget_keys); every management query carries
// an explicit tenant_id predicate (server-authoritative session tenant) as the isolation guard.

// The scope vocabulary is defined ONCE in @repo/contracts (the ApiKeyInput enum uses it too) — re-
// exported here so existing importers of apikeys.API_SCOPES are unchanged and the two can't drift.
export { API_SCOPES };
export type ApiScope = (typeof API_SCOPES)[number];

export interface ApiKeyResolved {
  id: string;
  tenantId: string;
  scopes: string[];
}

export interface ApiKeyPublic {
  id: string;
  name: string | null;
  keyPrefix: string;
  scopes: string[];
  enabled: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

function sha256(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

/** Resolve a secret API key → tenant + scopes (pre-tenant, BYPASSRLS). Enabled keys only.
 *  Bumps last_used_at fire-and-forget (never blocks the request). */
export async function resolveApiKey(secret: string | undefined): Promise<ApiKeyResolved | null> {
  if (!secret || !secret.startsWith("sk_")) return null;
  const r = await relayPool.query(
    `SELECT id, tenant_id, scopes FROM api_keys WHERE key_hash = $1 AND enabled = true`,
    [sha256(secret)],
  );
  if (!r.rowCount) return null;
  const row = r.rows[0];
  void relayPool
    .query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [row.id])
    .catch(() => {});
  return { id: row.id, tenantId: row.tenant_id, scopes: (row.scopes as string[]) ?? [] };
}

/** A tenant's API keys, newest first — metadata + prefix only, never the secret. */
export async function listApiKeys(tenantId: string): Promise<ApiKeyPublic[]> {
  const r = await relayPool.query(
    `SELECT id, name, key_prefix, scopes, enabled, last_used_at, created_at
       FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId],
  );
  return r.rows.map(toPublic);
}

/** Mint a key. Returns the public record PLUS the one-time plaintext secret. Unknown
 *  scopes are dropped (only API_SCOPES persist). */
export async function createApiKey(
  tenantId: string,
  input: { name?: string; scopes?: string[] },
  createdBy?: string | null,
): Promise<{ key: ApiKeyPublic; secret: string }> {
  const secret = "sk_" + crypto.randomBytes(24).toString("base64url");
  const prefix = secret.slice(0, 11); // 'sk_' + 8 chars, safe to display
  const scopes = (input.scopes ?? []).filter((s) => (API_SCOPES as readonly string[]).includes(s));
  const r = await relayPool.query(
    `INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash, scopes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, name, key_prefix, scopes, enabled, last_used_at, created_at`,
    [tenantId, input.name ?? null, prefix, sha256(secret), scopes, createdBy ?? null],
  );
  return { key: toPublic(r.rows[0]), secret };
}

/** Revoke (hard-delete) a key. The tenant_id predicate keeps it tenant-safe on the
 *  BYPASSRLS pool. */
export async function revokeApiKey(tenantId: string, id: string): Promise<boolean> {
  const r = await relayPool.query(`DELETE FROM api_keys WHERE tenant_id = $1 AND id = $2`, [
    tenantId,
    id,
  ]);
  return (r.rowCount ?? 0) > 0;
}

function toPublic(row: {
  id: string;
  name: string | null;
  key_prefix: string;
  scopes: string[] | null;
  enabled: boolean;
  last_used_at: string | null;
  created_at: string;
}): ApiKeyPublic {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    scopes: row.scopes ?? [],
    enabled: row.enabled,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
}
