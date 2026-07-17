import crypto from "node:crypto";
import { withTenant } from "@repo/db";

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

/** First-touch open. Idempotent; a click also implies an open (mail client fetched it). */
export async function trackOpen(tenantId: string, recipientId: string): Promise<void> {
  await withTenant(tenantId, async (c) => {
    await c.query("UPDATE broadcast_recipients SET opened_at = COALESCE(opened_at, now()) WHERE id = $1", [
      recipientId,
    ]);
  });
}

/** First-touch click (implies open — the recipient definitely saw the mail). */
export async function trackClick(tenantId: string, recipientId: string): Promise<void> {
  await withTenant(tenantId, async (c) => {
    await c.query(
      "UPDATE broadcast_recipients SET clicked_at = COALESCE(clicked_at, now()), opened_at = COALESCE(opened_at, now()) WHERE id = $1",
      [recipientId],
    );
  });
}

const trackingBase = (): string => {
  const sub = process.env.zeropsSubdomain;
  const base = sub ? (/^https?:\/\//.test(sub) ? sub : `https://${sub}`) : `http://localhost:${process.env.PORT ?? 3000}`;
  return base.replace(/\/+$/, "");
};

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
