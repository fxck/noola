import { withTenant } from "@repo/db";

// Model-B branded email — per-tenant custom SENDING domains (the Intercom "custom email domain"
// feature). A tenant verifies their OWN domain so outbound ticket replies send AS
// support@theirdomain with real DKIM/SPF, not from the shared platform domain.
//
// Two-sided: the provider (Resend) holds the authoritative domain object (it issues the DKIM keys
// and checks DNS); we cache its id + status + the DNS records the tenant must publish, in the
// RLS-isolated email_sending_domains table, so the settings wizard can DISPLAY the records and poll
// for verification. INBOUND routing (address→tenant) stays in email_routes; this governs OUTBOUND
// identity only.
//
// Provider seam: only Resend today, behind RESEND_API_KEY. When the key is UNSET the wizard still
// works in "local tracking" mode — the tenant adds the domain in the Resend dashboard by hand and
// we just record the intent (status='not_started', no DNS records fetched). Set the key to make it
// fully self-serve.

const RESEND_API = "https://api.resend.com";

/** True when the platform can talk to the email provider's domain API (self-serve mode). */
export function sendingProviderEnabled(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

// ---- row shape ------------------------------------------------------------

/** One DNS record the tenant must publish, as returned by the provider (Resend). Public config —
 *  safe to echo back verbatim; nothing secret lives here. */
export interface DnsRecord {
  record?: string;   // e.g. "SPF" | "DKIM" | "DMARC" (Resend's label)
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

// ---- provider (Resend) calls ----------------------------------------------

interface ResendDomain {
  id: string;
  name: string;
  status?: string;
  records?: DnsRecord[];
}

async function resendFetch(path: string, init: RequestInit): Promise<ResendDomain> {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new SendingProviderError("email provider not configured (RESEND_API_KEY unset)");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(`${RESEND_API}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers ?? {}) },
    });
  } catch (e) {
    throw new SendingProviderError(`email provider unreachable: ${(e as Error).message}`);
  } finally {
    clearTimeout(t);
  }
  const body = (await res.json().catch(() => ({}))) as ResendDomain & { message?: string };
  if (!res.ok) throw new SendingProviderError(body?.message || `email provider error (${res.status})`);
  return body;
}

/** Map a Resend domain payload to our stored fields. */
function fromResend(d: ResendDomain): { providerId: string; status: string; records: DnsRecord[] } {
  return { providerId: d.id, status: d.status ?? "pending", records: Array.isArray(d.records) ? d.records : [] };
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
 * Add a branded sending domain. When the provider is configured, create the domain object at Resend
 * (which mints the DKIM keys + returns the DNS records to publish) and store its id/status/records.
 * Without a provider key, store a local-only row (status='not_started') so the tenant can track the
 * domain they're setting up by hand in the Resend dashboard. Unique per (tenant, domain) — a
 * duplicate raises 23505 for the route to map to 409.
 */
export async function addSendingDomain(tenantId: string, domain: string): Promise<SendingDomainRow> {
  let providerId: string | null = null;
  let status = "not_started";
  let records: DnsRecord[] = [];
  if (sendingProviderEnabled()) {
    const created = fromResend(await resendFetch("/domains", { method: "POST", body: JSON.stringify({ name: domain }) }));
    providerId = created.providerId;
    status = created.status;
    records = created.records;
  }
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO email_sending_domains (tenant_id, domain, provider, provider_id, status, records)
       VALUES (current_tenant(), $1, 'resend', $2, $3, $4::jsonb) RETURNING ${COLS}`,
      [domain, providerId, status, JSON.stringify(records)],
    );
    return r.rows[0] as SendingDomainRow;
  });
}

/**
 * Re-check a domain's verification with the provider and refresh its stored status + records.
 * No-ops (returns the row unchanged) when there's no provider object to check (local-only tracking).
 * Calls Resend's verify endpoint (kicks a DNS re-check) then reads the fresh status.
 */
export async function refreshSendingDomain(tenantId: string, id: string): Promise<SendingDomainRow | null> {
  const row = await getRow(tenantId, id);
  if (!row) return null;
  if (!row.provider_id || !sendingProviderEnabled()) {
    // Local-only row (or provider now unconfigured) — just stamp the check time.
    return withTenant(tenantId, async (c) => {
      const r = await c.query(
        `UPDATE email_sending_domains SET last_checked_at = now() WHERE id = $1 RETURNING ${COLS}`, [id],
      );
      return r.rows[0] as SendingDomainRow;
    });
  }
  // Ask the provider to (re)verify, then read the authoritative current state.
  await resendFetch(`/domains/${row.provider_id}/verify`, { method: "POST" }).catch(() => ({}) as ResendDomain);
  const fresh = fromResend(await resendFetch(`/domains/${row.provider_id}`, { method: "GET" }));
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `UPDATE email_sending_domains SET status = $2, records = $3::jsonb, last_checked_at = now()
        WHERE id = $1 RETURNING ${COLS}`,
      [id, fresh.status, JSON.stringify(fresh.records)],
    );
    return r.rows[0] as SendingDomainRow;
  });
}

/** Remove a sending domain (best-effort delete at the provider, then the local row). */
export async function deleteSendingDomain(tenantId: string, id: string): Promise<boolean> {
  const row = await getRow(tenantId, id);
  if (!row) return false;
  if (row.provider_id && sendingProviderEnabled()) {
    await resendFetch(`/domains/${row.provider_id}`, { method: "DELETE" }).catch(() => ({}) as ResendDomain);
  }
  return withTenant(tenantId, async (c) => {
    const r = await c.query("DELETE FROM email_sending_domains WHERE id = $1", [id]);
    return (r.rowCount ?? 0) > 0;
  });
}
