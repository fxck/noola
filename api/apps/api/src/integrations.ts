import crypto from "node:crypto";
import { relayPool, withTenant } from "@repo/db";
import type { PoolClient } from "pg";
import { encryptSecret, decryptSecret, encryptionAvailable } from "./crypto.js";
import { sendOutboundEmail } from "./email.js";
import type { IntegrationInput, IntegrationUpdateInput, CredentialRef, IntegrationKind } from "@repo/contracts";

// ── Unified outbound-integration registry (Agent Studio) ─────────────────────
// Each row is a tenant's connector — the notify/action target an automation sends
// through. Credentials are encrypted at rest (crypto.ts, key = MODEL_KEY_SECRET) and NEVER
// returned on reads (masked to has_secret), unlike the legacy plaintext connectors. All
// reads/writes are RLS-scoped via withTenant; the channels overview additionally peeks the
// non-RLS routing tables (discord_links / email_routes / widget_keys) on the relay pool.

export interface IntegrationRow {
  id: string;
  kind: string;
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
  status: string;
  lastError: string | null;
  lastCheckedAt: string | null;
  hasSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DispatchMessage {
  subject?: string;
  text: string;
  context?: Record<string, unknown>;
}

export interface DispatchResult {
  ok: boolean;
  error?: string;
}

/** A loaded + decrypted connector — the reusable credential handle any consumer resolves through
 *  resolveCredential()/resolveIntegration() (the notify action today; workflow nodes / agent tools
 *  / the runner next). Unlike IntegrationRow (a masked read), this carries the decrypted `secret`,
 *  so it is internal-only and MUST never cross the API boundary. */
export interface ResolvedCredential {
  id: string;
  kind: string;
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
  secret: string | null;
}

/** Why a credential binding couldn't be resolved — lets callers branch (and the engine log a
 *  precise reason) instead of swallowing a generic failure. */
export type CredentialErrorCode = "not_found" | "disabled" | "wrong_kind" | "missing_secret";
export class CredentialError extends Error {
  code: CredentialErrorCode;
  constructor(code: CredentialErrorCode, message: string) {
    super(message);
    this.name = "CredentialError";
    this.code = code;
  }
}

// has_secret is a computed boolean — the encrypted blob never leaves the DB.
const SELECT_COLS =
  "id, kind, name, config, enabled, status, last_error, last_checked_at, (secret_enc IS NOT NULL) AS has_secret, created_at, updated_at";

function iso(v: unknown): string | null {
  return v ? new Date(v as string).toISOString() : null;
}

function mapRow(r: Record<string, unknown>): IntegrationRow {
  return {
    id: r.id as string,
    kind: r.kind as string,
    name: r.name as string,
    config: (r.config as Record<string, unknown>) ?? {},
    enabled: r.enabled as boolean,
    status: r.status as string,
    lastError: (r.last_error as string) ?? null,
    lastCheckedAt: iso(r.last_checked_at),
    hasSecret: Boolean(r.has_secret),
    createdAt: iso(r.created_at) as string,
    updatedAt: iso(r.updated_at) as string,
  };
}

/** True when a connector has everything it needs to actually dispatch. */
function isConfigured(kind: string, config: Record<string, unknown>, hasSecret: boolean): boolean {
  if (kind === "slack" || kind === "discord") return hasSecret; // the incoming-webhook URL
  if (kind === "email") return typeof config.to === "string" && (config.to as string).length > 0;
  if (kind === "http") return typeof config.url === "string" && (config.url as string).length > 0;
  return false;
}

function initialStatus(kind: string, config: Record<string, unknown>, hasSecret: boolean): string {
  return isConfigured(kind, config, hasSecret) ? "ok" : "unconfigured";
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export async function listIntegrations(tenantId: string): Promise<IntegrationRow[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(`SELECT ${SELECT_COLS} FROM integrations ORDER BY created_at DESC`);
    return r.rows.map(mapRow);
  });
}

export async function getIntegration(tenantId: string, id: string): Promise<IntegrationRow | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(`SELECT ${SELECT_COLS} FROM integrations WHERE id = $1`, [id]);
    return r.rowCount ? mapRow(r.rows[0]) : null;
  });
}

export async function createIntegration(tenantId: string, input: IntegrationInput): Promise<IntegrationRow> {
  if (input.secret && !encryptionAvailable()) throw new Error("encryption_unavailable");
  const secretEnc = input.secret ? encryptSecret(input.secret) : null;
  const config = input.config ?? {};
  const status = initialStatus(input.kind, config, Boolean(secretEnc));
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO integrations (tenant_id, kind, name, config, secret_enc, enabled, status)
       VALUES (current_tenant(), $1, $2, $3::jsonb, $4, $5, $6)
       RETURNING ${SELECT_COLS}`,
      [input.kind, input.name, JSON.stringify(config), secretEnc, input.enabled ?? true, status],
    );
    return mapRow(r.rows[0]);
  });
}

export async function updateIntegration(
  tenantId: string,
  id: string,
  patch: IntegrationUpdateInput,
): Promise<IntegrationRow | null> {
  if (patch.secret && !encryptionAvailable()) throw new Error("encryption_unavailable");
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (patch.name !== undefined) { sets.push(`name = $${i++}`); vals.push(patch.name); }
  if (patch.config !== undefined) { sets.push(`config = $${i++}::jsonb`); vals.push(JSON.stringify(patch.config)); }
  if (patch.enabled !== undefined) { sets.push(`enabled = $${i++}`); vals.push(patch.enabled); }
  // Secret: a non-empty value replaces it; omitted/empty leaves the stored one untouched.
  if (patch.secret) { sets.push(`secret_enc = $${i++}`); vals.push(encryptSecret(patch.secret)); }
  sets.push("updated_at = now()");
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `UPDATE integrations SET ${sets.join(", ")} WHERE id = $${i} RETURNING ${SELECT_COLS}`,
      [...vals, id],
    );
    return r.rowCount ? mapRow(r.rows[0]) : null;
  });
}

export async function deleteIntegration(tenantId: string, id: string): Promise<boolean> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query("DELETE FROM integrations WHERE id = $1", [id]);
    return (r.rowCount ?? 0) > 0;
  });
}

// ── Dispatch (the notify seam) ────────────────────────────────────────────────

async function load(c: PoolClient, id: string): Promise<ResolvedCredential | null> {
  const r = await c.query(
    "SELECT id, kind, name, config, enabled, secret_enc FROM integrations WHERE id = $1",
    [id],
  );
  if (!r.rowCount) return null;
  const row = r.rows[0];
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    config: row.config ?? {},
    enabled: row.enabled,
    secret: row.secret_enc ? decryptSecret(row.secret_enc) : null,
  };
}

/** Load + decrypt a connector by id, tenant-scoped. The reusable resolution seam: every consumer
 *  (notify dispatch, workflow nodes, agent tools, the runner) gets the same decrypted handle.
 *  Returns null when the id doesn't exist in the tenant (RLS-invisible rows read as absent). */
export async function resolveIntegration(tenantId: string, id: string): Promise<ResolvedCredential | null> {
  return withTenant(tenantId, (c) => load(c, id));
}

/** Resolve a per-node credential binding and enforce it's usable — exists, enabled, of an
 *  expected kind, and (optionally) carries a secret. Throws CredentialError on any miss so the
 *  caller branches/logs precisely. This is the primitive automation actions / workflow nodes /
 *  agent tools bind a connector through (the "auth per node" seam, generalized from notify). */
export async function resolveCredential(
  tenantId: string,
  ref: CredentialRef,
  opts: { expectKind?: IntegrationKind[]; requireSecret?: boolean } = {},
): Promise<ResolvedCredential> {
  const it = await resolveIntegration(tenantId, ref.integrationId);
  if (!it) throw new CredentialError("not_found", "integration not found");
  if (!it.enabled) throw new CredentialError("disabled", `integration ${it.name} is disabled`);
  if (opts.expectKind && !opts.expectKind.includes(it.kind as IntegrationKind)) {
    throw new CredentialError("wrong_kind", `integration ${it.name} is ${it.kind}, expected ${opts.expectKind.join("/")}`);
  }
  if (opts.requireSecret && !it.secret) {
    throw new CredentialError("missing_secret", `integration ${it.name} has no credential`);
  }
  return it;
}

// Coarse SSRF guard for admin-supplied delivery URLs. Requires http(s) and blocks obvious
// loopback / link-local / private literals. (webhooks.ts carries the mature DNS-aware guard;
// wiring these connectors onto that shared guard is a noted follow-up.)
function assertPublicUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("invalid url");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("url must be http or https");
  const h = u.hostname.toLowerCase();
  if (
    h === "localhost" ||
    h === "0.0.0.0" ||
    h === "::1" ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  ) {
    throw new Error("url resolves to a private address");
  }
}

async function postJson(url: string, body: unknown, hmacSecret: string | null): Promise<void> {
  const payload = JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (hmacSecret) {
    const sig = crypto.createHmac("sha256", hmacSecret).update(payload).digest("hex");
    headers["x-noola-signature"] = `sha256=${sig}`;
  }
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: payload,
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// Deliver a rendered message through one loaded connector. Throws on failure (the caller
// records status). tenantId is needed only by the email seam.
async function deliver(tenantId: string, it: ResolvedCredential, msg: DispatchMessage): Promise<void> {
  const { kind, config, secret } = it;
  if (kind === "slack" || kind === "discord") {
    if (!secret) throw new Error("missing webhook url");
    assertPublicUrl(secret);
    // Slack + Discord incoming webhooks accept a plain content payload.
    await postJson(secret, kind === "slack" ? { text: msg.text } : { content: msg.text }, null);
    return;
  }
  if (kind === "email") {
    const to = typeof config.to === "string" ? (config.to as string) : "";
    const res = await sendOutboundEmail(tenantId, to, msg.subject ?? "Automation", msg.text);
    if (!res.delivered) throw new Error(res.reason ?? "email not delivered");
    return;
  }
  if (kind === "http") {
    const url = typeof config.url === "string" ? (config.url as string) : "";
    assertPublicUrl(url);
    await postJson(url, { subject: msg.subject, text: msg.text, context: msg.context ?? {} }, secret);
    return;
  }
  throw new Error(`unknown kind ${kind}`);
}

async function stampStatus(c: PoolClient, id: string, ok: boolean, error: string | null): Promise<void> {
  await c.query(
    "UPDATE integrations SET status = $2, last_error = $3, last_checked_at = now() WHERE id = $1",
    [id, ok ? "ok" : "error", ok ? null : error],
  );
}

/** Send a message through an integration by id (the automation `notify` action). Records the
 *  outcome on the row's status. Never throws — returns {ok,error}. */
export async function dispatchIntegration(
  tenantId: string,
  id: string,
  msg: DispatchMessage,
): Promise<DispatchResult> {
  return withTenant(tenantId, async (c) => {
    const it = await load(c, id);
    if (!it) return { ok: false, error: "integration not found" };
    if (!it.enabled) return { ok: false, error: "integration disabled" };
    try {
      await deliver(tenantId, it, msg);
      await stampStatus(c, id, true, null);
      return { ok: true };
    } catch (e) {
      const error = (e as Error).message ?? String(e);
      await stampStatus(c, id, false, error);
      return { ok: false, error };
    }
  });
}

/** Health-check an integration by sending a test payload; records + returns the outcome. */
export async function testIntegration(tenantId: string, id: string): Promise<DispatchResult | null> {
  const exists = await getIntegration(tenantId, id);
  if (!exists) return null;
  return dispatchIntegration(tenantId, id, {
    subject: "Noola test",
    text: "✅ This is a test message from your Noola integration.",
    context: { event: "integration.test" },
  });
}

// ── Channels overview ─────────────────────────────────────────────────────────
// A unified read of the tenant's INBOUND channel bindings for the Integrations page's
// "Connected channels" section — counts across the pre-existing scattered connectors so the
// whole integration surface reads as one place. slack_connections + webhooks are RLS tables
// (withTenant); discord_links / email_routes / widget_keys are non-RLS routing tables read
// on the relay pool, filtered by tenant_id.

export interface ChannelsOverview {
  slack: number;
  discord: number;
  email: number;
  widget: number;
  webhooks: number;
}

export async function channelsOverview(tenantId: string): Promise<ChannelsOverview> {
  const rls = await withTenant(tenantId, async (c) => {
    const slack = await c.query("SELECT count(*)::int AS n FROM slack_connections WHERE active");
    const webhooks = await c.query("SELECT count(*)::int AS n FROM webhooks WHERE active");
    return { slack: slack.rows[0].n as number, webhooks: webhooks.rows[0].n as number };
  });
  const [disc, em, wk] = await Promise.all([
    relayPool.query("SELECT count(*)::int AS n FROM discord_links WHERE tenant_id = $1", [tenantId]),
    relayPool.query("SELECT count(*)::int AS n FROM email_routes WHERE tenant_id = $1", [tenantId]),
    relayPool.query("SELECT count(*)::int AS n FROM widget_keys WHERE tenant_id = $1 AND enabled", [tenantId]),
  ]);
  return {
    slack: rls.slack,
    webhooks: rls.webhooks,
    discord: disc.rows[0].n as number,
    email: em.rows[0].n as number,
    widget: wk.rows[0].n as number,
  };
}
