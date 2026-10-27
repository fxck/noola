import { randomBytes, createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { withTenant } from "@repo/db";

// Outbound webhooks. A tenant registers webhook URLs subscribed to events; when a
// subscribed event fires, the api POSTs an HMAC-signed JSON payload and records the
// delivery outcome. fireEvent is the emit seam — contacts.ts and ingest.ts call it
// fire-and-forget (dynamic import) after their writes commit, so a webhook never blocks
// or breaks the write that triggered it. Every function funnels through withTenant so
// tenant isolation is enforced in exactly one place.

export interface WebhookRow {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  has_secret: boolean;
  created_at: string;
}

export interface WebhookDeliveryRow {
  id: string;
  webhook_id: string;
  event: string;
  ok: boolean;
  status_code: number | null;
  error: string | null;
  created_at: string;
}

// secret is deliberately excluded — it's returned only by createWebhook, never listed.
const WEBHOOK_COLS =
  "id, url, events, active, (secret IS NOT NULL AND secret <> '') AS has_secret, created_at";
const DELIVERY_COLS = "id, webhook_id, event, ok, status_code, error, created_at";

const DELIVERY_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 512_000; // cap the signed body so a huge payload can't be blasted out

// ---- Test seam: the fetch used for delivery ------------------------------
// Production uses the global fetch. Tests inject a capturing/handler fetch so the suite
// is network-free (mirrors the connector-injection seam on sources.syncSource).
type FetchFn = typeof fetch;
let webhookFetch: FetchFn = (...args) => globalThis.fetch(...args);
export function __setWebhookFetch(fn: FetchFn | null): void {
  webhookFetch = fn ?? ((...args) => globalThis.fetch(...args));
}

// ---- CRUD ----------------------------------------------------------------

export async function listWebhooks(tenantId: string): Promise<WebhookRow[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(`SELECT ${WEBHOOK_COLS} FROM webhooks ORDER BY created_at DESC LIMIT 200`);
    return r.rows as WebhookRow[];
  });
}

export async function getWebhook(tenantId: string, id: string): Promise<WebhookRow | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(`SELECT ${WEBHOOK_COLS} FROM webhooks WHERE id = $1`, [id]);
    return r.rowCount ? (r.rows[0] as WebhookRow) : null;
  });
}

/** Create a webhook, generating a 32-byte hex HMAC secret. The secret is returned ONLY
 *  here (so the caller can copy it once); list/get never echo it again. */
export async function createWebhook(
  tenantId: string,
  input: { url: string; events?: string[]; active?: boolean },
): Promise<{ webhook: WebhookRow; secret: string }> {
  const secret = randomBytes(32).toString("hex");
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO webhooks (tenant_id, url, events, secret, active)
       VALUES (current_tenant(), $1, COALESCE($2,'{}'::text[]), $3, COALESCE($4, true))
       RETURNING ${WEBHOOK_COLS}`,
      [input.url, input.events ?? null, secret, input.active ?? null],
    );
    return { webhook: r.rows[0] as WebhookRow, secret };
  });
}

/** Partial update — toggle active, edit the events subscription, or change the url. Only
 *  provided fields change. The secret is immutable here (rotate = delete + recreate). */
export async function updateWebhook(
  tenantId: string,
  id: string,
  patch: { url?: string; events?: string[]; active?: boolean },
): Promise<WebhookRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const set = (col: string, val: unknown): void => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.url !== undefined) set("url", patch.url);
  if (patch.events !== undefined) set("events", patch.events);
  if (patch.active !== undefined) set("active", patch.active);
  if (!sets.length) return getWebhook(tenantId, id); // nothing to change
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `UPDATE webhooks SET ${sets.join(", ")} WHERE id = $1 RETURNING ${WEBHOOK_COLS}`,
      params,
    );
    return r.rowCount ? (r.rows[0] as WebhookRow) : null;
  });
}

export async function deleteWebhook(tenantId: string, id: string): Promise<boolean> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query("DELETE FROM webhooks WHERE id = $1", [id]);
    return (r.rowCount ?? 0) > 0;
  });
}

export async function listDeliveries(
  tenantId: string,
  webhookId: string,
  limit = 20,
): Promise<WebhookDeliveryRow[]> {
  const n = Math.min(Math.max(limit, 1), 200);
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT ${DELIVERY_COLS} FROM webhook_deliveries
        WHERE webhook_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [webhookId, n],
    );
    return r.rows as WebhookDeliveryRow[];
  });
}

// ---- SSRF guard ----------------------------------------------------------
// Only http(s); block loopback / link-local / RFC1918 / cloud-metadata — as literals AND
// after DNS resolution, so a public hostname that resolves to a private IP (a metadata
// alias or a DNS-rebinding record) is rejected too. Redirects aren't followed (the fetch
// uses redirect:"manual"), which closes the redirect-to-private hop.
function isPrivateIp(ip: string): boolean {
  const mapped = ip.toLowerCase().match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  const addr = mapped ? mapped[1] : ip;
  const m = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return (
      a === 0 ||
      a === 127 || // loopback
      a === 10 || // 10/8
      (a === 172 && b >= 16 && b <= 31) || // 172.16/12
      (a === 192 && b === 168) || // 192.168/16
      (a === 169 && b === 254) || // link-local, incl. 169.254.169.254 cloud metadata
      a >= 224 // multicast / reserved
    );
  }
  const l = addr.toLowerCase();
  return (
    l === "::1" || // loopback
    l === "::" ||
    l.startsWith("fe80:") || // link-local
    l.startsWith("fc") || // unique-local fc00::/7
    l.startsWith("fd")
  );
}

async function isAllowedUrl(raw: string): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  // Test seam: the suite mocks fetch with unresolvable hostnames, which the DNS step below
  // would otherwise block before the mock is reached. Never set outside tests.
  const allow = process.env.WEBHOOK_SSRF_ALLOW;
  if (allow && allow.split(",").some((h) => h.trim().toLowerCase() === host)) return true;
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    host === "0.0.0.0"
  ) {
    return false;
  }
  // Literal IP (v4 or v6) → decide directly.
  if (/^[0-9.]+$/.test(host) || host.includes(":")) {
    return !isPrivateIp(host);
  }
  // Hostname → resolve and reject if ANY resolved address is private (DNS-rebinding guard).
  try {
    const addrs = await lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
  } catch {
    return false; // unresolvable → block
  }
}

// ---- Delivery ------------------------------------------------------------

/** POST one signed payload to one webhook and record the delivery row. Never throws —
 *  every failure (blocked url, oversized body, timeout, non-2xx, network) is captured as
 *  a delivery with ok=false. Returns the recorded row (so sendTestPing can echo it). */
async function deliverOne(
  tenantId: string,
  hook: { id: string; url: string; secret: string },
  event: string,
  payload: unknown,
): Promise<WebhookDeliveryRow> {
  const body = JSON.stringify({ event, occurredAt: new Date().toISOString(), data: payload });
  let ok = false;
  let statusCode: number | null = null;
  let error: string | null = null;

  if (!(await isAllowedUrl(hook.url))) {
    error = "blocked or invalid url (SSRF guard)";
  } else if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    error = "payload too large";
  } else {
    const signature = `sha256=${createHmac("sha256", hook.secret).update(body).digest("hex")}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), DELIVERY_TIMEOUT_MS);
    try {
      const res = await webhookFetch(hook.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-noola-event": event,
          "x-noola-signature": signature,
        },
        body,
        signal: ctrl.signal,
        redirect: "manual", // don't follow redirects into an un-vetted host
      });
      statusCode = res.status;
      ok = res.ok;
      if (!res.ok) error = `http ${res.status}`;
    } catch (e) {
      error = (e as Error).message ?? "delivery failed";
    } finally {
      clearTimeout(t);
    }
  }
  return recordDelivery(tenantId, hook.id, event, ok, statusCode, error);
}

async function recordDelivery(
  tenantId: string,
  webhookId: string,
  event: string,
  ok: boolean,
  statusCode: number | null,
  error: string | null,
): Promise<WebhookDeliveryRow> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO webhook_deliveries (tenant_id, webhook_id, event, ok, status_code, error)
       VALUES (current_tenant(), $1, $2, $3, $4, $5)
       RETURNING ${DELIVERY_COLS}`,
      [webhookId, event, ok, statusCode, error],
    );
    return r.rows[0] as WebhookDeliveryRow;
  });
}

/**
 * The emit seam. Selects the tenant's ACTIVE webhooks subscribed to `event` (an empty
 * events array = all events), then POSTs `{ event, occurredAt, data: payload }` to each,
 * signed with the webhook's secret, recording a delivery per attempt. Fire-and-forget:
 * sequential, and the whole thing is wrapped so it NEVER throws into the caller — a
 * webhook failure must not affect the write that triggered it.
 */
export async function fireEvent(tenantId: string, event: string, payload: unknown): Promise<void> {
  try {
    const hooks = await withTenant(tenantId, async (c) => {
      const r = await c.query(
        `SELECT id, url, secret FROM webhooks
          WHERE active = true AND (cardinality(events) = 0 OR $1 = ANY(events))`,
        [event],
      );
      return r.rows as { id: string; url: string; secret: string }[];
    });
    for (const h of hooks) {
      await deliverOne(tenantId, h, event, payload).catch(() => {});
    }
  } catch {
    // fire-and-forget: swallow everything (incl. DB lookup failures)
  }
}

/** Fire a synthetic `ping` event to a single webhook and return the delivery result
 *  synchronously — powers POST /webhooks/:id/test so the tenant can verify wiring. */
export async function sendTestPing(tenantId: string, id: string): Promise<WebhookDeliveryRow | null> {
  const hook = await withTenant(tenantId, async (c) => {
    const r = await c.query("SELECT id, url, secret FROM webhooks WHERE id = $1", [id]);
    return r.rowCount ? (r.rows[0] as { id: string; url: string; secret: string }) : null;
  });
  if (!hook) return null;
  return deliverOne(tenantId, hook, "ping", { message: "pong", webhookId: id });
}
