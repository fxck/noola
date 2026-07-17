import crypto from "node:crypto";
import { relayPool } from "@repo/db";
import {
  type WidgetConfig,
  type WidgetConfigInput,
  mergeWidgetConfig,
  resolveStoredWidgetConfig,
} from "@repo/contracts";

// Ask-AI embeddable widget: public keys → tenant routing + management. widget_keys sits
// OUTSIDE RLS (like email_routes/discord_links) because /public/ask resolves the tenant
// from the key BEFORE any tenant context exists — so every query here runs on the
// BYPASSRLS relay pool, and the management functions carry an explicit tenant_id predicate
// (server-authoritative session tenant) as the isolation guard.

export interface WidgetKey {
  tenantId: string;
  allowedDomains: string[];
  config: WidgetConfig;
}

export interface WidgetKeyPublic {
  publicKey: string;
  label: string | null;
  allowedDomains: string[];
  enabled: boolean;
  createdAt: string;
  config: WidgetConfig;
}

/** Resolve a public widget key → its tenant + allowlist + personalization (pre-tenant,
 *  BYPASSRLS). Only enabled keys resolve. `config` is always fully populated (defaults fill gaps). */
export async function resolveWidgetKey(key: string): Promise<WidgetKey | null> {
  const r = await relayPool.query(
    `SELECT tenant_id, allowed_domains, config FROM widget_keys WHERE public_key = $1 AND enabled = true`,
    [key],
  );
  if (!r.rowCount) return null;
  return {
    tenantId: r.rows[0].tenant_id,
    allowedDomains: r.rows[0].allowed_domains ?? [],
    config: resolveStoredWidgetConfig(r.rows[0].config),
  };
}

/** Is `origin` allowed for this key? Empty allowlist = any origin (dev). Matches on host
 *  (scheme-insensitive) and permits subdomains, so an allowlist entry "acme.com" allows
 *  "https://acme.com" and "https://support.acme.com". */
export function originAllowed(allowed: string[], origin: string | undefined): boolean {
  if (!allowed.length) return true; // no allowlist configured → open lane
  if (!origin) return false; // allowlist set but request carried no Origin → deny
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    host = origin;
  }
  return allowed.some((d) => {
    const dh = d.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
    const h = host.toLowerCase();
    return h === dh || h.endsWith("." + dh);
  });
}

function newKey(): string {
  return "wk_" + crypto.randomBytes(24).toString("base64url");
}

/** A tenant's widget keys, newest first (management surface). */
export async function listWidgetKeys(tenantId: string): Promise<WidgetKeyPublic[]> {
  const r = await relayPool.query(
    `SELECT public_key, label, allowed_domains, enabled, created_at, config
       FROM widget_keys WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId],
  );
  return r.rows.map(toPublic);
}

export async function createWidgetKey(
  tenantId: string,
  input: { label?: string; allowedDomains?: string[] },
): Promise<WidgetKeyPublic> {
  const r = await relayPool.query(
    `INSERT INTO widget_keys (public_key, tenant_id, label, allowed_domains)
     VALUES ($1, $2, $3, $4)
     RETURNING public_key, label, allowed_domains, enabled, created_at, config`,
    [newKey(), tenantId, input.label ?? null, input.allowedDomains ?? []],
  );
  return toPublic(r.rows[0]);
}

/** Update a key's management fields + personalization. The tenant_id predicate makes this
 *  tenant-safe on the BYPASSRLS pool. `config` shallow-merges over the stored personalization
 *  (so a partial patch flips one field); label/allowedDomains overwrite when provided. Returns
 *  the updated public row, or null when the key isn't this tenant's. */
export async function updateWidgetKey(
  tenantId: string,
  key: string,
  input: { label?: string | null; allowedDomains?: string[]; config?: WidgetConfigInput },
): Promise<WidgetKeyPublic | null> {
  const cur = await relayPool.query(
    `SELECT config FROM widget_keys WHERE tenant_id = $1 AND public_key = $2`,
    [tenantId, key],
  );
  if (!cur.rowCount) return null;
  const nextConfig = mergeWidgetConfig(resolveStoredWidgetConfig(cur.rows[0].config), input.config);
  const sets: string[] = ["config = $3::jsonb"];
  const params: unknown[] = [tenantId, key, JSON.stringify(nextConfig)];
  if (input.label !== undefined) {
    params.push(input.label);
    sets.push(`label = $${params.length}`);
  }
  if (input.allowedDomains !== undefined) {
    params.push(input.allowedDomains);
    sets.push(`allowed_domains = $${params.length}`);
  }
  const r = await relayPool.query(
    `UPDATE widget_keys SET ${sets.join(", ")}
      WHERE tenant_id = $1 AND public_key = $2
      RETURNING public_key, label, allowed_domains, enabled, created_at, config`,
    params,
  );
  return r.rowCount ? toPublic(r.rows[0]) : null;
}

/** Revoke a key. The tenant_id predicate makes this tenant-safe even on the BYPASSRLS pool. */
export async function deleteWidgetKey(tenantId: string, key: string): Promise<boolean> {
  const r = await relayPool.query(
    `DELETE FROM widget_keys WHERE tenant_id = $1 AND public_key = $2`,
    [tenantId, key],
  );
  return (r.rowCount ?? 0) > 0;
}

function toPublic(row: {
  public_key: string;
  label: string | null;
  allowed_domains: string[] | null;
  enabled: boolean;
  created_at: string;
  config: unknown;
}): WidgetKeyPublic {
  return {
    publicKey: row.public_key,
    label: row.label,
    allowedDomains: row.allowed_domains ?? [],
    enabled: row.enabled,
    createdAt: row.created_at,
    config: resolveStoredWidgetConfig(row.config),
  };
}
