import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { withTenant } from "@repo/db";
import { EVENT_TYPES } from "@repo/contracts";
import { publicApiBase } from "./env.js";

// Broadcast engagement tracking — the open pixel and click redirect behind /t/*. Same
// signed-token discipline as unsubscribe.ts: the token names one (tenant, recipient-row)
// and verifies against a server-side HMAC, so the public endpoints can't be enumerated.
// The CLICK token additionally signs the DESTINATION URL — without that, /t/c would be an
// open redirect for spam/phishing (any URL laundered through our domain). First-touch
// only: opened_at/clicked_at are COALESCE-set once; re-opens don't churn rows.

function key(): Buffer | null {
  const s = process.env.UNSUBSCRIBE_SECRET || process.env.MODEL_KEY_SECRET;
  if (!s) return null;
  return crypto.createHash("sha256").update(`noola:tracking:${s}`).digest();
}

export function trackingAvailable(): boolean {
  return key() !== null;
}

function uuidBytes(id: string): Buffer | null {
  const hex = id.replace(/-/g, "");
  return /^[0-9a-f]{32}$/i.test(hex) ? Buffer.from(hex, "hex") : null;
}

function bytesUuid(b: Buffer): string {
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function mac(payload: Buffer, url: string): Buffer | null {
  const k = key();
  if (!k) return null;
  return crypto.createHmac("sha256", k).update(payload).update(url).digest().subarray(0, 24);
}

/** Mint a token for one recipient row; pass `url` for click tokens (it's part of the MAC). */
export function mintTrackToken(tenantId: string, recipientId: string, url = ""): string | null {
  const t = uuidBytes(tenantId);
  const r = uuidBytes(recipientId);
  if (!t || !r) return null;
  const payload = Buffer.concat([t, r]);
  const m = mac(payload, url);
  return m ? `${payload.toString("base64url")}.${m.toString("base64url")}` : null;
}

/** Verify a token (+ the url it was minted for, for click tokens). Constant-time compare. */
export function verifyTrackToken(
  token: string,
  url = "",
): { tenantId: string; recipientId: string } | null {
  const [payloadB64, macB64] = token.split(".");
  if (!payloadB64 || !macB64) return null;
  let payload: Buffer;
  let given: Buffer;
  try {
    payload = Buffer.from(payloadB64, "base64url");
    given = Buffer.from(macB64, "base64url");
  } catch {
    return null;
  }
  if (payload.length !== 32) return null;
  const expected = mac(payload, url);
  if (!expected || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  return { tenantId: bytesUuid(payload.subarray(0, 16)), recipientId: bytesUuid(payload.subarray(16)) };
}

/** Emit a broadcast-updated event on the transactional outbox so the edge relays a live UI nudge — the
 *  broadcast detail refetches its engagement tallies. Runs INSIDE the caller's txn (atomic with the
 *  open/click stamp), reusing the existing broadcast-updated channel the detail already listens on. */
async function emitBroadcastEngagement(c: PoolClient, tenantId: string, broadcastId: string, status: string): Promise<void> {
  const envelope = {
    id: broadcastId,
    type: EVENT_TYPES.broadcastUpdated,
    tenantId,
    occurredAt: new Date().toISOString(),
    data: { broadcastId, status },
  };
  await c.query(
    "INSERT INTO outbox (tenant_id, event_type, subject, payload) VALUES (current_tenant(), $1, 'noola.events.' || current_tenant(), $2::jsonb)",
    [EVENT_TYPES.broadcastUpdated, JSON.stringify(envelope)],
  );
}

/** First-touch open. Idempotent; a click also implies an open (mail client fetched it). Emits a live
 *  broadcast-updated nudge ONLY on the first open — a re-loaded pixel must not spam realtime — so the
 *  detail page's Opened tally climbs live even for a terminal (Sent) broadcast that no longer polls. */
export async function trackOpen(tenantId: string, recipientId: string): Promise<void> {
  await withTenant(tenantId, async (c) => {
    // `(opened_at = now())` is true only when THIS statement just set it (transaction_timestamp is
    // stable in-txn) → reliable first-touch detection while keeping the idempotent COALESCE stamp.
    const r = await c.query(
      "UPDATE broadcast_recipients SET opened_at = COALESCE(opened_at, now()) WHERE id = $1 RETURNING broadcast_id, (opened_at = now()) AS first_open",
      [recipientId],
    );
    // Intercom-parity "Last opened email" on the recipient's contact (RLS scopes the join).
    await c.query(
      `UPDATE contacts
          SET attributes = COALESCE(attributes, '{}'::jsonb) || jsonb_build_object('Last opened email', now()::text)
         FROM broadcast_recipients br
        WHERE br.id = $1 AND contacts.id = br.contact_id`,
      [recipientId],
    );
    if (r.rowCount && r.rows[0].first_open) {
      const b = await c.query("SELECT status FROM broadcasts WHERE id = $1", [r.rows[0].broadcast_id]);
      if (b.rowCount) await emitBroadcastEngagement(c, tenantId, r.rows[0].broadcast_id, b.rows[0].status);
    }
  });
}

/** First-touch click (implies open — the recipient definitely saw the mail). Emits a live nudge on the
 *  first click, same as trackOpen. */
export async function trackClick(tenantId: string, recipientId: string): Promise<void> {
  await withTenant(tenantId, async (c) => {
    const r = await c.query(
      "UPDATE broadcast_recipients SET clicked_at = COALESCE(clicked_at, now()), opened_at = COALESCE(opened_at, now()) WHERE id = $1 RETURNING broadcast_id, (clicked_at = now()) AS first_click",
      [recipientId],
    );
    // Intercom-parity "Last clicked on link in email" (+ implied open) on the contact.
    await c.query(
      `UPDATE contacts
          SET attributes = COALESCE(attributes, '{}'::jsonb)
                           || jsonb_build_object('Last clicked on link in email', now()::text, 'Last opened email', now()::text)
         FROM broadcast_recipients br
        WHERE br.id = $1 AND contacts.id = br.contact_id`,
      [recipientId],
    );
    if (r.rowCount && r.rows[0].first_click) {
      const b = await c.query("SELECT status FROM broadcasts WHERE id = $1", [r.rows[0].broadcast_id]);
      if (b.rowCount) await emitBroadcastEngagement(c, tenantId, r.rows[0].broadcast_id, b.rows[0].status);
    }
  });
}

const trackingBase = (): string => publicApiBase();

/** Append the auto-UTM triplet to an http(s) destination. A destination that already
 *  carries any utm_* param is left alone — the author's campaign tagging wins. */
export function appendUtm(url: string, campaign: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return url;
    if ([...u.searchParams.keys()].some((k) => k.toLowerCase().startsWith("utm_"))) return url;
    u.searchParams.set("utm_source", "noola");
    u.searchParams.set("utm_medium", "email");
    u.searchParams.set("utm_campaign", campaign);
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Instrument one recipient's rendered HTML: every external http(s) href gets UTM params and
 * is wrapped in the signed click redirect; a 1×1 open pixel lands before </body>. Our own
 * lanes (the /u/ unsubscribe link, already-wrapped /t/ links) are left untouched. Called
 * per recipient AFTER merge-tag substitution, so merge-tag URLs are tracked too.
 */
export function instrumentHtml(
  html: string,
  tenantId: string,
  recipientId: string,
  campaign: string,
): string {
  const base = trackingBase();
  if (!trackingAvailable()) return html;
  let out = html.replace(/href="(https?:\/\/[^"]+)"/g, (whole, url: string) => {
    if (url.startsWith(`${base}/u/`) || url.startsWith(`${base}/t/`)) return whole;
    const dest = appendUtm(url, campaign);
    const token = mintTrackToken(tenantId, recipientId, dest);
    if (!token) return whole;
    return `href="${base}/t/c/${token}?u=${encodeURIComponent(dest)}"`;
  });
  const openToken = mintTrackToken(tenantId, recipientId);
  if (openToken) {
    const pixel = `<img src="${base}/t/o/${openToken}" width="1" height="1" alt="" style="display:none" />`;
    out = out.includes("</body>") ? out.replace("</body>", `${pixel}</body>`) : out + pixel;
  }
  return out;
}

/** 1×1 transparent GIF — the smallest thing a mail client will happily fetch. */
export const PIXEL_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
