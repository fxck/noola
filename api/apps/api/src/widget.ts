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
  /** Per-key HMAC secret for Intercom-style identity verification (migration 0095). Never sent
   *  to the browser — used server-side to recompute + compare the client's user_hash. */
  identitySecret: string | null;
}

export interface WidgetKeyPublic {
  publicKey: string;
  label: string | null;
  allowedDomains: string[];
  enabled: boolean;
  createdAt: string;
  config: WidgetConfig;
  /** The identity-verification secret, surfaced only to the authed dashboard (Settings →
   *  Messenger) so an admin can compute user_hash on their own server. Like Intercom's secret,
   *  it's viewable in-app but never shipped to the widget. */
  identitySecret: string | null;
}

/** Resolve a public widget key → its tenant + allowlist + personalization + identity secret
 *  (pre-tenant, BYPASSRLS). Only enabled keys resolve. `config` is always fully populated. */
export async function resolveWidgetKey(key: string): Promise<WidgetKey | null> {
  const r = await relayPool.query(
    `SELECT tenant_id, allowed_domains, config, identity_secret FROM widget_keys WHERE public_key = $1 AND enabled = true`,
    [key],
  );
  if (!r.rowCount) return null;
  return {
    tenantId: r.rows[0].tenant_id,
    allowedDomains: r.rows[0].allowed_domains ?? [],
    config: resolveStoredWidgetConfig(r.rows[0].config),
    identitySecret: r.rows[0].identity_secret ?? null,
  };
}

/** The identifier an identity is HMAC'd over — the user_id when present, else the email
 *  (Intercom uses whichever handle you identify people by). Returns null when anonymous. */
export function identityIdentifier(userId?: string | null, email?: string | null): string | null {
  return (userId && userId.trim()) || (email && email.trim()) || null;
}

/** Compute the expected user_hash for an identifier (hex HMAC-SHA256, matching Intercom's scheme
 *  so the host can generate it with any standard crypto lib). */
export function computeUserHash(secret: string, identifier: string): string {
  return crypto.createHmac("sha256", secret).update(identifier).digest("hex");
}

/** Constant-time verify of a client-supplied user_hash against ONE identifier. False on any
 *  missing input, so a caller that never set up verification (or a forged/absent hash) is
 *  simply "not verified" — never an exception. */
export function verifyUserHash(
  secret: string | null | undefined,
  identifier: string | null | undefined,
  provided: string | null | undefined,
): boolean {
  if (!secret || !identifier || !provided) return false;
  const expected = Buffer.from(computeUserHash(secret, identifier), "utf8");
  const given = Buffer.from(provided, "utf8");
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** Verify a user_hash against EITHER handle (user_id or email). Intercom's LEGACY scheme hashes
 *  whichever identifier the workspace is configured for; accepting a match on either means an
 *  existing Intercom-generating backend works unchanged — same algorithm, secret, and message. */
export function verifyIdentity(
  secret: string | null | undefined,
  ids: { userId?: string | null; email?: string | null },
  provided: string | null | undefined,
): boolean {
  if (!secret || !provided) return false;
  return [ids.userId, ids.email]
    .map((v) => (v ? v.trim() : ""))
    .filter(Boolean)
    .some((id) => verifyUserHash(secret, id, provided));
}

/** Verify an Intercom-style identity JWT (`intercom_user_jwt`). Intercom's CURRENT scheme signs a
 *  JWT with `jwt.sign(payload, MessengerApiSecret)` — HS256, i.e. HMAC-SHA256 with the secret as
 *  the key — carrying user_id/email in the claims. We verify the signature with the SAME secret and
 *  return the trusted identity from the payload, so a workspace pastes its Messenger API Secret and
 *  the JWT its backend already emits validates here with zero changes. Returns null on any failure
 *  (bad shape, wrong alg, bad signature, expired, no identity claim). No external JWT lib — HS256 is
 *  a base64url HMAC we can check directly. */
export function verifyIdentityJwt(
  secret: string | null | undefined,
  token: string | null | undefined,
): { userId: string | null; email: string | null } | null {
  if (!secret || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const expected = crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest();
  let given: Buffer;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let header: { alg?: string };
  let payload: { user_id?: unknown; email?: unknown; exp?: unknown };
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (header.alg !== "HS256") return null; // Intercom signs HS256; reject anything else
  if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) return null; // expired
  const userId = payload.user_id != null ? String(payload.user_id) : null;
  const email = payload.email != null ? String(payload.email) : null;
  if (!userId && !email) return null;
  return { userId, email };
}

/** The unified identity gate for the public lanes. Prefers Intercom's CURRENT JWT
 *  (`intercom_user_jwt` → identity comes FROM the signed claims), falls back to the LEGACY
 *  user_hash HMAC (identity is client-sent, the hash proves it). Returns the identity to trust +
 *  whether it's verified. When neither proof is present/valid, `verified` is false and the
 *  client-sent identity is returned as-is for the caller to accept (verification off) or drop (on). */
export function resolveVerifiedIdentity(
  wk: WidgetKey,
  input: { userId?: string | null; email?: string | null; userHash?: string | null; userJwt?: string | null },
): { userId: string | null; email: string | null; verified: boolean } {
  if (input.userJwt) {
    const claims = verifyIdentityJwt(wk.identitySecret, input.userJwt);
    if (claims) return { userId: claims.userId, email: claims.email, verified: true };
    return { userId: input.userId ?? null, email: input.email ?? null, verified: false };
  }
  const verified = verifyIdentity(wk.identitySecret, { userId: input.userId, email: input.email }, input.userHash);
  return { userId: input.userId ?? null, email: input.email ?? null, verified };
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

/** A fresh identity-verification secret — 64 hex chars (256-bit), matching the migration backfill. */
function newSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

const PUBLIC_COLS = "public_key, label, allowed_domains, enabled, created_at, config, identity_secret";

/** A tenant's widget keys, newest first (management surface). */
export async function listWidgetKeys(tenantId: string): Promise<WidgetKeyPublic[]> {
  const r = await relayPool.query(
    `SELECT ${PUBLIC_COLS}
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
    `INSERT INTO widget_keys (public_key, tenant_id, label, allowed_domains, identity_secret)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${PUBLIC_COLS}`,
    [newKey(), tenantId, input.label ?? null, input.allowedDomains ?? [], newSecret()],
  );
  return toPublic(r.rows[0]);
}

/** Set a key's identity-verification secret. Pass an explicit `secret` to BRING YOUR OWN — e.g.
 *  paste your existing Intercom Identity Verification secret so the user_hash your backend already
 *  computes validates here with zero code changes (same HMAC-SHA256, same message). Omit it to
 *  rotate to a fresh random secret (invalidates every previously-issued hash). Tenant-safe. */
export async function setIdentitySecret(
  tenantId: string,
  key: string,
  secret?: string,
): Promise<WidgetKeyPublic | null> {
  const value = secret && secret.trim() ? secret.trim() : newSecret();
  const r = await relayPool.query(
    `UPDATE widget_keys SET identity_secret = $3
      WHERE tenant_id = $1 AND public_key = $2
      RETURNING ${PUBLIC_COLS}`,
    [tenantId, key, value],
  );
  return r.rowCount ? toPublic(r.rows[0]) : null;
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
      RETURNING ${PUBLIC_COLS}`,
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
  identity_secret: string | null;
}): WidgetKeyPublic {
  return {
    publicKey: row.public_key,
    label: row.label,
    allowedDomains: row.allowed_domains ?? [],
    enabled: row.enabled,
    createdAt: row.created_at,
    config: resolveStoredWidgetConfig(row.config),
    identitySecret: row.identity_secret ?? null,
  };
}
