import { withTenant } from "@repo/db";
import { emailDomainCredsForTenant, getTenantEmailProvider, type EmailProviderName } from "./email-provider.js";

// Model-B branded email — per-tenant custom SENDING domains (the Intercom "custom email domain"
// feature). A tenant verifies their OWN domain so outbound ticket replies send AS support@theirdomain
// with real DKIM/SPF, not from the shared platform domain.
//
// Two-sided: the provider holds the authoritative domain object (it issues the DKIM keys and checks
// DNS); we cache its id + status + the DNS records the tenant must publish, in the RLS-isolated
// email_sending_domains table, so the settings wizard can DISPLAY the records and poll for
// verification. INBOUND routing (address→tenant) stays in email_routes; this governs OUTBOUND identity.
//
// Provider seam: Resend AND SendGrid. The provider+key is resolved PER TENANT — a BYO tenant's own
// account (so their domains live in THEIR account with THEIR DKIM) else the shared Resend env key. The
// domain's provider is stamped on the row so verify/delete route to the right API. When no key is
// available the wizard still works in "local tracking" mode — the tenant authenticates the domain in
// their provider dashboard by hand and we just record the intent (status='not_started').

const RESEND_API = "https://api.resend.com";
const SENDGRID_API = "https://api.sendgrid.com";

/** True when a tenant can talk to the email provider's domain API (self-serve mode) — via their BYO
 *  key or the shared env key. */
export async function sendingProviderEnabled(tenantId: string): Promise<boolean> {
  return Boolean(await emailDomainCredsForTenant(tenantId));
}

// ---- row shape ------------------------------------------------------------

/** One DNS record the tenant must publish (SPF/DKIM/DMARC/MX/CNAME), as returned by the provider.
 *  Public config — safe to echo back verbatim; nothing secret lives here. */
export interface DnsRecord {
  record?: string;   // provider's label (e.g. "DKIM", "mail_cname", "dkim1")
  type: string;      // "MX" | "TXT" | "CNAME"
  name: string;      // host
  value: string;     // record value
  ttl?: string;
  priority?: number;
  status?: string;   // provider's per-record verification state
}

export interface SendingDomainRow {
  id: string;
  domain: string;
  provider: string;
  provider_id: string | null;
  status: string;
  records: DnsRecord[];
  last_checked_at: string | null;
  created_at: string;
}

const COLS = "id, domain, provider, provider_id, status, records, last_checked_at, created_at";

/** Thrown when the provider API rejects a call — surfaced as a 502 to the client. */
export class SendingProviderError extends Error {}

// ---- provider API (Resend + SendGrid) -------------------------------------

interface NormalizedDomain {
  providerId: string;
  status: string; // pending | verified (mapped from each provider's vocabulary)
  records: DnsRecord[];
}

interface DomainAdapter {
  create(apiKey: string, domain: string): Promise<NormalizedDomain>;
  refresh(apiKey: string, providerId: string): Promise<NormalizedDomain>;
  remove(apiKey: string, providerId: string): Promise<void>;
}

/** One Bearer-authed JSON call to a provider API, with a timeout and unified error extraction (Resend
 *  `{message}` / SendGrid `{errors:[{message}]}`). */
async function apiFetch<T = Record<string, unknown>>(url: string, init: RequestInit, key: string): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers ?? {}) },
    });
  } catch (e) {
    throw new SendingProviderError(`email provider unreachable: ${(e as Error).message}`);
  } finally {
    clearTimeout(t);
  }
  const body = (await res.json().catch(() => ({}))) as { message?: string; errors?: { message?: string }[] } & T;
  if (!res.ok) {
    throw new SendingProviderError(body?.message || body?.errors?.[0]?.message || `email provider error (${res.status})`);
  }
  return body;
}

// -- Resend --

interface ResendDomain { id: string; name?: string; status?: string; records?: DnsRecord[] }
function normalizeResend(d: ResendDomain): NormalizedDomain {
  return { providerId: d.id, status: d.status ?? "pending", records: Array.isArray(d.records) ? d.records : [] };
}

const resendAdapter: DomainAdapter = {
  create: async (key, domain) =>
    normalizeResend(await apiFetch<ResendDomain>(`${RESEND_API}/domains`, { method: "POST", body: JSON.stringify({ name: domain }) }, key)),
  refresh: async (key, id) => {
    await apiFetch(`${RESEND_API}/domains/${id}/verify`, { method: "POST" }, key).catch(() => ({}));
    return normalizeResend(await apiFetch<ResendDomain>(`${RESEND_API}/domains/${id}`, { method: "GET" }, key));
  },
  remove: async (key, id) => {
    await apiFetch(`${RESEND_API}/domains/${id}`, { method: "DELETE" }, key).catch(() => ({}));
  },
};

// -- SendGrid (Sender Authentication / "domain whitelabel") --

interface SendgridDnsEntry { valid?: boolean; type?: string; host?: string; data?: string }
interface SendgridDomain { id?: number | string; valid?: boolean; dns?: Record<string, SendgridDnsEntry> }
/** Exported for unit testing the dns→DnsRecord mapping. */
export function normalizeSendgrid(d: SendgridDomain): NormalizedDomain {
  const dns = d.dns ?? {};
  const records: DnsRecord[] = Object.entries(dns).map(([label, e]) => ({
    record: label,
    type: (e.type ?? "CNAME").toUpperCase(),
    name: e.host ?? "",
    value: e.data ?? "",
    status: e.valid ? "valid" : "pending",
  }));
  return { providerId: String(d.id ?? ""), status: d.valid ? "verified" : "pending", records };
}

const sendgridAdapter: DomainAdapter = {
  // automatic_security=true → SendGrid holds the DKIM keys and hands back CNAMEs to publish.
  create: async (key, domain) =>
    normalizeSendgrid(
      await apiFetch<SendgridDomain>(`${SENDGRID_API}/v3/whitelabel/domains`, { method: "POST", body: JSON.stringify({ domain, automatic_security: true }) }, key),
    ),
  refresh: async (key, id) => {
    await apiFetch(`${SENDGRID_API}/v3/whitelabel/domains/${id}/validate`, { method: "POST" }, key).catch(() => ({}));
    return normalizeSendgrid(await apiFetch<SendgridDomain>(`${SENDGRID_API}/v3/whitelabel/domains/${id}`, { method: "GET" }, key));
  },
  remove: async (key, id) => {
    await apiFetch(`${SENDGRID_API}/v3/whitelabel/domains/${id}`, { method: "DELETE" }, key).catch(() => ({}));
  },
};

function adapterFor(provider: EmailProviderName): DomainAdapter {
  return provider === "sendgrid" ? sendgridAdapter : resendAdapter;
}

// ---- CRUD -----------------------------------------------------------------

export async function listSendingDomains(tenantId: string): Promise<SendingDomainRow[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(`SELECT ${COLS} FROM email_sending_domains ORDER BY created_at ASC`);
    return r.rows as SendingDomainRow[];
  });
}

async function getRow(tenantId: string, id: string): Promise<SendingDomainRow | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(`SELECT ${COLS} FROM email_sending_domains WHERE id = $1`, [id]);
    return r.rowCount ? (r.rows[0] as SendingDomainRow) : null;
  });
}

/**
 * Add a branded sending domain. When a provider key is available, create the domain object at the
 * tenant's provider (which mints the DKIM records to publish) and store its id/status/records. Without
 * a key, store a local-only row (status='not_started') so the tenant can track the domain they're
 * authenticating by hand in the provider dashboard. The row's `provider` is stamped so verify/delete
 * route to the right API. Unique per (tenant, domain) — a duplicate raises 23505 → 409.
 */
export async function addSendingDomain(tenantId: string, domain: string): Promise<SendingDomainRow> {
  const creds = await emailDomainCredsForTenant(tenantId);
  const configured = await getTenantEmailProvider(tenantId);
  const provider: EmailProviderName = creds?.provider ?? configured?.provider ?? "resend";
  let providerId: string | null = null;
  let status = "not_started";
  let records: DnsRecord[] = [];
  if (creds) {
    const created = await adapterFor(creds.provider).create(creds.apiKey, domain);
    providerId = created.providerId;
    status = created.status;
    records = created.records;
  }
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO email_sending_domains (tenant_id, domain, provider, provider_id, status, records)
       VALUES (current_tenant(), $1, $2, $3, $4, $5::jsonb) RETURNING ${COLS}`,
      [domain, provider, providerId, status, JSON.stringify(records)],
    );
    return r.rows[0] as SendingDomainRow;
  });
}

/**
 * Re-check a domain's verification with its provider and refresh the stored status + records. Uses the
 * ROW's provider (so a tenant who switched providers still verifies old domains correctly). No-ops
 * (just stamps last_checked_at) when there's no provider object, no key, or the tenant's current key is
 * for a different provider than the row.
 */
export async function refreshSendingDomain(tenantId: string, id: string): Promise<SendingDomainRow | null> {
  const row = await getRow(tenantId, id);
  if (!row) return null;
  const creds = await emailDomainCredsForTenant(tenantId);
  const rowProvider = (row.provider === "sendgrid" ? "sendgrid" : "resend") as EmailProviderName;
  if (!row.provider_id || !creds || creds.provider !== rowProvider) {
    return withTenant(tenantId, async (c) => {
      const r = await c.query(
        `UPDATE email_sending_domains SET last_checked_at = now() WHERE id = $1 RETURNING ${COLS}`, [id],
      );
      return r.rows[0] as SendingDomainRow;
    });
  }
  const fresh = await adapterFor(rowProvider).refresh(creds.apiKey, row.provider_id);
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `UPDATE email_sending_domains SET status = $2, records = $3::jsonb, last_checked_at = now()
        WHERE id = $1 RETURNING ${COLS}`,
      [id, fresh.status, JSON.stringify(fresh.records)],
    );
    return r.rows[0] as SendingDomainRow;
  });
}

/** Remove a sending domain (best-effort delete at the provider by the row's provider, then the local row). */
export async function deleteSendingDomain(tenantId: string, id: string): Promise<boolean> {
  const row = await getRow(tenantId, id);
  if (!row) return false;
  const creds = await emailDomainCredsForTenant(tenantId);
  const rowProvider = (row.provider === "sendgrid" ? "sendgrid" : "resend") as EmailProviderName;
  if (row.provider_id && creds && creds.provider === rowProvider) {
    await adapterFor(rowProvider).remove(creds.apiKey, row.provider_id).catch(() => {});
  }
  return withTenant(tenantId, async (c) => {
    const r = await c.query("DELETE FROM email_sending_domains WHERE id = $1", [id]);
    return (r.rowCount ?? 0) > 0;
  });
}
