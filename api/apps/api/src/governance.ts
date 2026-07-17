import { relayPool, withTenant } from "@repo/db";
import { deleteObject } from "./storage.js";
import { recordAudit } from "./audit.js";

// Workspace governance policies (0092) — one tenant_policies row per tenant:
//   retention_days  → the daily sweep hard-deletes CLOSED tickets idle longer than the window
//                     (messages + attachment rows cascade; attachment objects best-effort).
//   ip_allowlist    → agent-console requests must come from a listed IP/CIDR. Enforced in the
//                     `tenanted` wrapper; loopback + RFC1918 are always allowed (dev servers,
//                     in-container tests, health probes), and PUBLIC surfaces (widget, webhooks,
//                     unsubscribe, SCIM) never pass through `tenanted`, so they're unaffected.
//   require_2fa     → workspace wants every member enrolled; surfaced to the SPA (soft gate:
//                     the app nags/blocks in the shell) + on the members roster for admins.

type Log = { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

export interface TenantPolicies {
  retentionDays: number | null;
  ipAllowlist: string[];
  require2fa: boolean;
}

const DEFAULTS: TenantPolicies = { retentionDays: null, ipAllowlist: [], require2fa: false };

function mapRow(r: Record<string, unknown> | undefined): TenantPolicies {
  if (!r) return { ...DEFAULTS };
  return {
    retentionDays: r.retention_days == null ? null : Number(r.retention_days),
    ipAllowlist: Array.isArray(r.ip_allowlist) ? (r.ip_allowlist as string[]).map(String) : [],
    require2fa: Boolean(r.require_2fa),
  };
}

export async function getPolicies(tenantId: string): Promise<TenantPolicies> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query("SELECT retention_days, ip_allowlist, require_2fa FROM tenant_policies WHERE tenant_id = current_tenant()");
    return mapRow(r.rows[0] as Record<string, unknown> | undefined);
  });
}

export async function putPolicies(tenantId: string, patch: Partial<TenantPolicies>): Promise<TenantPolicies> {
  const current = await getPolicies(tenantId);
  const next: TenantPolicies = {
    retentionDays: patch.retentionDays !== undefined ? patch.retentionDays : current.retentionDays,
    ipAllowlist: patch.ipAllowlist !== undefined ? patch.ipAllowlist : current.ipAllowlist,
    require2fa: patch.require2fa !== undefined ? patch.require2fa : current.require2fa,
  };
  await withTenant(tenantId, async (c) => {
    await c.query(
      `INSERT INTO tenant_policies (tenant_id, retention_days, ip_allowlist, require_2fa, updated_at)
       VALUES (current_tenant(), $1, $2::jsonb, $3, now())
       ON CONFLICT (tenant_id) DO UPDATE
         SET retention_days = EXCLUDED.retention_days, ip_allowlist = EXCLUDED.ip_allowlist,
             require_2fa = EXCLUDED.require_2fa, updated_at = now()`,
      [next.retentionDays, JSON.stringify(next.ipAllowlist), next.require2fa],
    );
  });
  bustPolicyCache(tenantId);
  return next;
}

// ---- IP allowlist ------------------------------------------------------------

/** Exact-match or IPv4-CIDR containment. IPv6 supports exact match only (a /prefix on IPv6
 *  is accepted syntactically but matches only the exact address part). */
export function ipMatches(ip: string, rule: string): boolean {
  const r = rule.trim();
  if (!r) return false;
  if (!r.includes("/")) return ip === r;
  const [base, prefixRaw] = r.split("/");
  const prefix = Number(prefixRaw);
  const ip4 = ipv4ToInt(ip);
  const base4 = ipv4ToInt(base);
  if (ip4 === null || base4 === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return ip === base;
  }
  if (prefix === 0) return true;
  const mask = prefix === 32 ? 0xffffffff : (~((1 << (32 - prefix)) - 1)) >>> 0;
  return ((ip4 & mask) >>> 0) === ((base4 & mask) >>> 0);
}

function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** Infra-internal callers are always allowed: loopback, RFC1918, link-local — dev servers,
 *  in-container tests and platform health probes must never lock out. */
export function isInternalIp(ip: string): boolean {
  if (ip === "127.0.0.1" || ip === "::1" || ip.startsWith("::ffff:127.")) return true;
  const n = ipv4ToInt(ip.replace(/^::ffff:/, ""));
  if (n === null) return ip.toLowerCase().startsWith("fe80:") || ip.toLowerCase().startsWith("fc") || ip.toLowerCase().startsWith("fd");
  return (
    (n >>> 24) === 10 ||
    ((n >>> 20) === ((172 << 4) | 1)) || // 172.16.0.0/12
    ((n >>> 16) === ((192 << 8) | 168)) || // 192.168.0.0/16
    (n >>> 24) === 127 ||
    ((n >>> 16) === ((169 << 8) | 254)) // 169.254.0.0/16
  );
}

export function ipAllowed(ip: string, list: string[]): boolean {
  if (!list.length) return true;
  if (isInternalIp(ip)) return true;
  const bare = ip.replace(/^::ffff:/, "");
  return list.some((rule) => ipMatches(bare, rule) || ipMatches(ip, rule));
}

// Per-tenant policy cache — `tenanted` consults this on EVERY agent request, so the steady
// state must be query-free. Saves bust their own tenant; other instances converge in ≤30s.
const policyCache = new Map<string, { at: number; policies: TenantPolicies }>();
const POLICY_CACHE_MS = 30_000;

export function bustPolicyCache(tenantId?: string): void {
  if (tenantId) policyCache.delete(tenantId);
  else policyCache.clear();
}

export async function cachedPolicies(tenantId: string): Promise<TenantPolicies> {
  const hit = policyCache.get(tenantId);
  if (hit && Date.now() - hit.at < POLICY_CACHE_MS) return hit.policies;
  const policies = await getPolicies(tenantId).catch(() => ({ ...DEFAULTS }));
  policyCache.set(tenantId, { at: Date.now(), policies });
  return policies;
}

/** The `tenanted` gate: is this request's source IP allowed into the agent console? */
export async function tenantIpAllowed(tenantId: string, ip: string): Promise<boolean> {
  const p = await cachedPolicies(tenantId);
  return ipAllowed(ip, p.ipAllowlist);
}

// ---- data retention sweep ----------------------------------------------------

/** Daily sweep: for every tenant with a retention window, hard-delete closed tickets whose
 *  last activity is older than the window. Messages + attachment ROWS cascade with the ticket;
 *  attachment OBJECTS are deleted best-effort first (a missed object never blocks the sweep). */
export async function runRetentionSweep(log: Log): Promise<void> {
  let tenants: { tenant_id: string; retention_days: number }[];
  try {
    const r = await relayPool.query(
      "SELECT tenant_id, retention_days FROM tenant_policies WHERE retention_days IS NOT NULL AND retention_days > 0",
    );
    tenants = r.rows as { tenant_id: string; retention_days: number }[];
  } catch (err) {
    log.warn({ err }, "retention: tenant discovery failed");
    return;
  }
  for (const t of tenants) {
    try {
      const removed = await withTenant(t.tenant_id, async (c) => {
        const doomed = await c.query(
          `SELECT id FROM tickets WHERE status = 'closed' AND updated_at < now() - ($1 || ' days')::interval`,
          [String(t.retention_days)],
        );
        const ids = doomed.rows.map((r: { id: string }) => r.id);
        if (!ids.length) return 0;
        const atts = await c.query(
          "SELECT storage_key FROM message_attachments WHERE ticket_id = ANY($1::uuid[])",
          [ids],
        );
        for (const a of atts.rows as { storage_key: string }[]) {
          // CDN-passthrough rows (discord urls) aren't ours to delete; owned keys are path-like.
          if (a.storage_key && !/^https?:\/\//.test(a.storage_key)) {
            await deleteObject(a.storage_key).catch(() => {});
          }
        }
        await c.query("DELETE FROM tickets WHERE id = ANY($1::uuid[])", [ids]);
        return ids.length;
      });
      if (removed > 0) log.info({ tenantId: t.tenant_id, removed }, "retention: swept closed tickets");
    } catch (err) {
      log.error({ err, tenantId: t.tenant_id }, "retention: sweep failed");
    }
  }
}

// ---- GDPR: export + erase ----------------------------------------------------

/** Everything we hold about one contact, as a portable JSON bundle. */
export async function exportContactData(tenantId: string, contactId: string): Promise<Record<string, unknown> | null> {
  return withTenant(tenantId, async (c) => {
    const contact = await c.query("SELECT * FROM contacts WHERE id = $1", [contactId]);
    if (!contact.rowCount) return null;
    const [identities, events, tickets] = await Promise.all([
      c.query("SELECT channel_type, external_id, created_at FROM contact_identities WHERE contact_id = $1", [contactId]),
      c.query("SELECT name, payload, created_at FROM contact_events WHERE contact_id = $1 ORDER BY created_at", [contactId]).catch(() => ({ rows: [] })),
      c.query("SELECT id, subject, status, channel_type, created_at, updated_at FROM tickets WHERE contact_id = $1 ORDER BY created_at", [contactId]),
    ]);
    const ticketIds = tickets.rows.map((t: { id: string }) => t.id);
    const messages = ticketIds.length
      ? await c.query(
          "SELECT ticket_id, author_type, body, channel_type, created_at FROM messages WHERE ticket_id = ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY created_at",
          [ticketIds],
        )
      : { rows: [] };
    return {
      exportedAt: new Date().toISOString(),
      contact: contact.rows[0],
      identities: identities.rows,
      events: events.rows,
      tickets: tickets.rows,
      messages: messages.rows,
    };
  });
}

/** GDPR erasure: hard-delete the contact AND every conversation that belongs to them —
 *  tickets (messages/attachment rows cascade), owned attachment objects, then the contact row
 *  (identities/events cascade with it per 0062). Audited. Returns false when no such contact. */
export async function eraseContact(tenantId: string, contactId: string, actorId: string | null): Promise<boolean> {
  const found = await withTenant(tenantId, async (c) => {
    const contact = await c.query("SELECT id, email FROM contacts WHERE id = $1", [contactId]);
    if (!contact.rowCount) return false;
    const tickets = await c.query("SELECT id FROM tickets WHERE contact_id = $1", [contactId]);
    const ids = tickets.rows.map((r: { id: string }) => r.id);
    if (ids.length) {
      const atts = await c.query("SELECT storage_key FROM message_attachments WHERE ticket_id = ANY($1::uuid[])", [ids]);
      for (const a of atts.rows as { storage_key: string }[]) {
        if (a.storage_key && !/^https?:\/\//.test(a.storage_key)) {
          await deleteObject(a.storage_key).catch(() => {});
        }
      }
      await c.query("DELETE FROM tickets WHERE id = ANY($1::uuid[])", [ids]);
    }
    await c.query("DELETE FROM contacts WHERE id = $1", [contactId]);
    return true;
  });
  if (found) {
    await recordAudit(tenantId, { actorId, action: "contact.erased", entityType: "contact", entityId: contactId }).catch(() => {});
  }
  return found;
}
