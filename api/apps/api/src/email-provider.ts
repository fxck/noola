import { randomBytes } from "node:crypto";
import { relayPool, withTenant } from "@repo/db";
import { encryptSecret, decryptSecret, encryptionAvailable } from "./crypto.js";

// BYO Resend (0103) — a workspace brings its OWN Resend account so outbound + inbound email flow
// through their credentials, not the shared platform key. One row per tenant in
// email_provider_settings; secrets ride the same crypto.ts MODEL_KEY_SECRET box as channel
// credentials / model keys, and are write-only (the API exposes only hasApiKey / hasWebhookSecret).
//
// Three consumers resolve a tenant's key:
//   - outbound  (email.ts)         → tenantResendApiKey(): the tenant's Resend SMTP password.
//   - domains   (email-domains.ts) → resendApiKeyForTenant(): tenant key ?? shared env fallback.
//   - inbound   (settings route)   → resolveTenantByInboundHandle(): pre-tenant, by webhook URL.
//
// The inbound path is the one non-obvious piece: Resend's webhook is Svix-signed with the tenant's
// OWN secret, but the tenant is only known after reading the (untrusted) body. So each BYO tenant
// gets a unique inbound URL — /email/inbound/resend/<inbound_handle> — and the handle resolves the
// tenant (+ their secret + key) BEFORE verification. Reads across tenants via the BYPASSRLS relay,
// exactly like email_routes and the channel-connection pollers.

export class EmailProviderSecretsUnavailableError extends Error {}

/** The email providers a workspace can bring. Both are SMTP for outbound; they differ on inbound
 *  (Resend = Svix-signed webhook + fetch-back; SendGrid = Inbound Parse multipart, body inline). */
export type EmailProviderName = "resend" | "sendgrid";
export const EMAIL_PROVIDERS: EmailProviderName[] = ["resend", "sendgrid"];
export function isEmailProvider(v: unknown): v is EmailProviderName {
  return v === "resend" || v === "sendgrid";
}

/** Safe (secret-free) view of a tenant's provider settings, for the Settings UI. */
export interface EmailProviderStatus {
  provider: EmailProviderName;
  hasApiKey: boolean;
  hasWebhookSecret: boolean;
  inboundHandle: string;
  active: boolean;
  updatedAt: string | null;
}

function newInboundHandle(): string {
  // URL-safe, unguessable, and comfortably unique — the public inbound webhook path segment.
  return randomBytes(24).toString("base64url");
}

/** The tenant's provider settings (secret-free), or null when they haven't configured BYO. */
export async function getTenantEmailProvider(tenantId: string): Promise<EmailProviderStatus | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT provider, (api_key_enc IS NOT NULL) AS has_api_key,
              (webhook_secret_enc IS NOT NULL) AS has_webhook_secret,
              inbound_handle, active, updated_at
         FROM email_provider_settings WHERE tenant_id = current_tenant()`,
    );
    if (!r.rowCount) return null;
    const row = r.rows[0] as Record<string, unknown>;
    return {
      provider: (isEmailProvider(row.provider) ? row.provider : "resend"),
      hasApiKey: Boolean(row.has_api_key),
      hasWebhookSecret: Boolean(row.has_webhook_secret),
      inboundHandle: row.inbound_handle as string,
      active: Boolean(row.active),
      updatedAt: row.updated_at ? new Date(row.updated_at as string).toISOString() : null,
    };
  });
}

/**
 * Upsert a tenant's BYO Resend credentials. Partial: pass apiKey and/or webhookSecret to set/replace
 * just those; pass an EMPTY STRING to clear one; omit (undefined) to leave it untouched. A handle is
 * minted on first save so the UI can show the inbound webhook URL immediately. Secrets are encrypted
 * at rest — never stored or returned in plaintext.
 */
export async function saveTenantEmailProvider(
  tenantId: string,
  input: { provider?: EmailProviderName; apiKey?: string; webhookSecret?: string; active?: boolean },
): Promise<EmailProviderStatus> {
  if (!encryptionAvailable()) {
    throw new EmailProviderSecretsUnavailableError("MODEL_KEY_SECRET is not set — cannot store email provider credentials");
  }
  const setApiKey = input.apiKey !== undefined;
  const setWebhook = input.webhookSecret !== undefined;
  // Empty string clears; a non-empty value encrypts; undefined leaves the column as-is.
  const apiKeyEnc = setApiKey ? (input.apiKey ? encryptSecret(input.apiKey.trim()) : null) : null;
  const webhookEnc = setWebhook ? (input.webhookSecret ? encryptSecret(input.webhookSecret.trim()) : null) : null;
  const provider = input.provider ?? null; // null = keep existing (insert defaults to 'resend')
  await withTenant(tenantId, async (c) => {
    await c.query(
      `INSERT INTO email_provider_settings (tenant_id, provider, inbound_handle, api_key_enc, webhook_secret_enc, active)
       VALUES (current_tenant(), COALESCE($7, 'resend'), $1, $2, $3, COALESCE($4, true))
       ON CONFLICT (tenant_id) DO UPDATE SET
         provider           = COALESCE($7, email_provider_settings.provider),
         api_key_enc        = CASE WHEN $5 THEN $2 ELSE email_provider_settings.api_key_enc END,
         webhook_secret_enc = CASE WHEN $6 THEN $3 ELSE email_provider_settings.webhook_secret_enc END,
         active             = COALESCE($4, email_provider_settings.active),
         updated_at         = now()`,
      [newInboundHandle(), apiKeyEnc, webhookEnc, input.active ?? null, setApiKey, setWebhook, provider],
    );
  });
  const status = await getTenantEmailProvider(tenantId);
  if (!status) throw new Error("email provider save did not persist");
  return status;
}

/** Remove a tenant's BYO provider settings entirely (revert to the shared env account). */
export async function deleteTenantEmailProvider(tenantId: string): Promise<boolean> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query("DELETE FROM email_provider_settings WHERE tenant_id = current_tenant()");
    return (r.rowCount ?? 0) > 0;
  });
}

/** Mint a fresh inbound handle (invalidates the old webhook URL) — after a suspected leak. */
export async function rotateInboundHandle(tenantId: string): Promise<string | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      "UPDATE email_provider_settings SET inbound_handle = $1, updated_at = now() WHERE tenant_id = current_tenant() RETURNING inbound_handle",
      [newInboundHandle()],
    );
    return r.rowCount ? (r.rows[0].inbound_handle as string) : null;
  });
}

// ---- credential resolution (send + fetch paths) ---------------------------

export interface TenantProviderCreds {
  provider: EmailProviderName;
  apiKey: string;
}

/** The tenant's own email-provider credentials (provider + decrypted key), or null when they haven't
 *  brought one. Drives the outbound transport (Resend vs SendGrid SMTP) and the inbound fetch-back. */
export async function tenantEmailProviderCreds(tenantId: string): Promise<TenantProviderCreds | null> {
  const row = await withTenant(tenantId, async (c) => {
    const r = await c.query(
      "SELECT provider, api_key_enc FROM email_provider_settings WHERE tenant_id = current_tenant() AND active = true",
    );
    return r.rowCount ? (r.rows[0] as { provider: string; api_key_enc: string | null }) : null;
  });
  if (!row?.api_key_enc) return null;
  const apiKey = decryptSecret(row.api_key_enc);
  if (!apiKey) return null;
  return { provider: isEmailProvider(row.provider) ? row.provider : "resend", apiKey };
}

/** The Resend key to use for a tenant's OUTBOUND provider calls (the DOMAIN WIZARD, Resend-only): the
 *  tenant's BYO key when they're on Resend, else the shared env key. A SendGrid BYO tenant never lends
 *  its key to the Resend API — it falls back to env (or null = local-only tracking). */
export async function resendApiKeyForTenant(tenantId: string): Promise<string | null> {
  const creds = await tenantEmailProviderCreds(tenantId);
  if (creds?.provider === "resend") return creds.apiKey;
  return process.env.RESEND_API_KEY ?? null;
}

/** The provider + key the DOMAIN WIZARD should talk to for a tenant: their BYO provider+key when
 *  present (Resend or SendGrid — domains live in THEIR account), else the shared Resend env key as the
 *  platform fallback. Null → no self-serve provider (the wizard degrades to local tracking). */
export async function emailDomainCredsForTenant(tenantId: string): Promise<TenantProviderCreds | null> {
  const creds = await tenantEmailProviderCreds(tenantId);
  if (creds) return creds;
  return process.env.RESEND_API_KEY ? { provider: "resend", apiKey: process.env.RESEND_API_KEY } : null;
}

// ---- pre-tenant inbound resolution (webhook handle → tenant) --------------

export interface InboundHandleResolution {
  tenantId: string;
  provider: EmailProviderName;  // how to parse/verify the inbound (Resend Svix vs SendGrid Inbound Parse)
  apiKey: string | null;        // for the Resend body/attachment fetch-back
  webhookSecret: string | null; // for Resend's Svix signature verification (unused by SendGrid)
}

/** Resolve a BYO inbound webhook handle to its tenant + provider + decrypted secrets. BYPASSRLS relay
 *  read (pre-tenant, like email_routes) — the whole point is to identify the tenant before we can
 *  verify/parse. Null when the handle is unknown or the row is inactive. */
export async function resolveTenantByInboundHandle(handle: string): Promise<InboundHandleResolution | null> {
  if (!handle) return null;
  const r = await relayPool.query(
    "SELECT tenant_id, provider, api_key_enc, webhook_secret_enc FROM email_provider_settings WHERE inbound_handle = $1 AND active = true",
    [handle],
  );
  if (!r.rowCount) return null;
  const row = r.rows[0] as { tenant_id: string; provider: string; api_key_enc: string | null; webhook_secret_enc: string | null };
  return {
    tenantId: row.tenant_id,
    provider: isEmailProvider(row.provider) ? row.provider : "resend",
    apiKey: row.api_key_enc ? decryptSecret(row.api_key_enc) : null,
    webhookSecret: row.webhook_secret_enc ? decryptSecret(row.webhook_secret_enc) : null,
  };
}
