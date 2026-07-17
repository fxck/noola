import crypto from "node:crypto";
import { withTenant } from "@repo/db";

// Marketing opt-out — the compliance seam for broadcasts (CAN-SPAM/GDPR). Every broadcast
// email carries a per-recipient signed unsubscribe URL (footer link + RFC 8058
// List-Unsubscribe headers); the public /u/:token routes verify the token and stamp
// contacts.unsubscribed_at. The token IS the authorization: an HMAC over
// "<tenantId>:<contactId>" — unguessable without the signing secret, no session needed,
// and deliberately non-expiring (an opt-out link in an old email must keep working).
//
// Suppression itself is enforced in broadcasts.ts at resolve/preview time (channel-agnostic:
// an opt-out is an opt-out, chat channels included). Ticket replies are transactional and
// exempt — they never route through this module.

/** HMAC key derived from the strongest secret available. UNSUBSCRIBE_SECRET wins when the
 *  operator sets one; MODEL_KEY_SECRET (project-level, always present here) is the working
 *  fallback so links are signable out of the box. Context-prefixed so the derived key can
 *  never collide with crypto.ts's encryption key even though the source secret is shared. */
function key(): Buffer | null {
  const s = process.env.UNSUBSCRIBE_SECRET || process.env.MODEL_KEY_SECRET;
  if (!s) return null;
  return crypto.createHash("sha256").update(`noola:unsubscribe:${s}`).digest();
}

const b64u = (b: Buffer): string => b.toString("base64url");

/** Whether opt-out links are mintable at all (a signing secret is configured). */
export function unsubscribeAvailable(): boolean {
  return key() !== null;
}

function sign(payload: string): Buffer | null {
  const k = key();
  if (!k) return null;
  return crypto.createHmac("sha256", k).update(payload).digest();
}

// UUIDs travel as their 16 raw bytes, not hex text — the token has to fit Fastify's
// default 100-char route-param cap (and short URLs wrap less in plaintext email):
// b64u(tenant16+contact16) "." b64u(mac24) ≈ 76 chars.
function uuidBytes(id: string): Buffer | null {
  const hex = id.replace(/-/g, "");
  return /^[0-9a-f]{32}$/i.test(hex) ? Buffer.from(hex, "hex") : null;
}

function bytesUuid(b: Buffer): string {
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Mint the opt-out token for one contact. Returns null only when no signing secret is
 *  configured or the ids aren't UUIDs (callers omit the link). */
export function mintUnsubscribeToken(tenantId: string, contactId: string): string | null {
  const t = uuidBytes(tenantId);
  const c = uuidBytes(contactId);
  if (!t || !c) return null;
  const payload = Buffer.concat([t, c]);
  const mac = sign(payload.toString("base64url"));
  return mac ? `${b64u(payload)}.${mac.subarray(0, 24).toString("base64url")}` : null;
}

/** Verify a token and return its identity, or null on any mismatch (bad shape, bad MAC,
 *  missing secret). Constant-time MAC compare. */
export function verifyUnsubscribeToken(token: string): { tenantId: string; contactId: string } | null {
  const [payloadB64, macB64] = token.split(".");
  if (!payloadB64 || !macB64) return null;
  let payload: Buffer;
  try {
    payload = Buffer.from(payloadB64, "base64url");
  } catch {
    return null;
  }
  if (payload.length !== 32) return null;
  const expected = sign(payload.toString("base64url"))?.subarray(0, 24);
  let given: Buffer;
  try {
    given = Buffer.from(macB64, "base64url");
  } catch {
    return null;
  }
  if (!expected || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  return { tenantId: bytesUuid(payload.subarray(0, 16)), contactId: bytesUuid(payload.subarray(16)) };
}

/** Absolute public URL for one contact's opt-out page, or null when unsignable. Points at
 *  THIS api's subdomain (zeropsSubdomain — same source betterauth's baseURL uses), so dev
 *  links land on apidev and stage links on apistage. */
export function unsubscribeUrl(tenantId: string, contactId: string): string | null {
  const token = mintUnsubscribeToken(tenantId, contactId);
  if (!token) return null;
  const sub = process.env.zeropsSubdomain;
  const base = sub
    ? /^https?:\/\//.test(sub)
      ? sub
      : `https://${sub}`
    : `http://localhost:${process.env.PORT ?? 3000}`;
  return `${base.replace(/\/+$/, "")}/u/${token}`;
}

/** Flip one contact's marketing subscription. Returns the contact's email-ish display handle
 *  for the confirmation page, or null when the contact is gone. Idempotent — re-clicking a
 *  link keeps the original opt-out timestamp. */
export async function setSubscription(
  tenantId: string,
  contactId: string,
  unsubscribed: boolean,
): Promise<{ email: string | null; name: string } | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      unsubscribed
        ? "UPDATE contacts SET unsubscribed_at = COALESCE(unsubscribed_at, now()) WHERE id = $1 RETURNING email, name"
        : "UPDATE contacts SET unsubscribed_at = NULL WHERE id = $1 RETURNING email, name",
      [contactId],
    );
    return r.rowCount ? (r.rows[0] as { email: string | null; name: string }) : null;
  });
}
