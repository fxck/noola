import { createHmac, timingSafeEqual } from "node:crypto";
import {
  handleInboundEmail,
  resolveTenantByAddress,
  parseInboundAddress,
  ORIGIN_HEADER,
  type InboundEmail,
} from "./email.js";
import type { IngestResult } from "./ingest.js";

// Native Resend Inbound (email.received) integration. Resend delivers a Svix-signed webhook that
// carries METADATA ONLY — no body, no headers, no attachment bytes. We verify the signature, then
// fetch the parsed body (+ headers, for the echo guard) and each attachment back from Resend's
// Receiving API, and hand the normalized email to the SAME handleInboundEmail() spine the Mailpit
// poller and the generic /email/inbound webhook use — so routing (per-ticket reply tokens, contact
// threading, idempotency by Message-ID) is identical across every inbound path.
//
// Config: RESEND_WEBHOOK_SECRET = the webhook's Svix signing secret (whsec_…); RESEND_API_KEY = the
// same key that powers the sending-domain (DKIM) wizard, reused here to fetch the body/attachments.

const RESEND_API = "https://api.resend.com";
const INBOUND_ATTACH_MAX_BYTES = 10 * 1024 * 1024;
const INBOUND_ATTACH_MAX_FILES = 10;
const SVIX_TOLERANCE_SEC = 5 * 60;

export interface ResendInboundResult {
  status: number;
  ingested: boolean;
  ticketId?: string | null;
  reason?: string;
}

/** Verify a Resend (Svix) webhook signature over the RAW request body. Svix's scheme:
 *  HMAC-SHA256( base64-decode(secret without the "whsec_" prefix), `${svix-id}.${svix-timestamp}.${rawBody}` ),
 *  base64-compared (timing-safe) against each `v1,<sig>` token in the svix-signature header, with a
 *  timestamp tolerance to blunt replay. No SDK — mirrors the app's own Slack HMAC verification. */
export function verifyResendSignature(
  rawBody: string,
  headers: { id?: string; timestamp?: string; signature?: string },
  secret: string | undefined,
): boolean {
  const { id, timestamp, signature } = headers;
  if (!secret || !id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > SVIX_TOLERANCE_SEC) return false;
  const key = secret.startsWith("whsec_") ? Buffer.from(secret.slice(6), "base64") : Buffer.from(secret, "base64");
  const expected = Buffer.from(createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest("base64"));
  for (const token of signature.split(" ")) {
    const comma = token.indexOf(",");
    if (comma !== -1 && token.slice(0, comma) !== "v1") continue; // only v1 (HMAC-SHA256)
    const got = Buffer.from(comma === -1 ? token : token.slice(comma + 1));
    if (got.length === expected.length && timingSafeEqual(got, expected)) return true;
  }
  return false;
}

/** `"Display Name <addr@host>"` | `"addr@host"` → `{ address, name? }` (address lowercased, +tag kept). */
export function parseAddress(v: string | undefined | null): { address: string; name?: string } {
  const s = String(v ?? "").trim();
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(s);
  if (m) return { address: m[2].trim().toLowerCase(), name: (m[1] || "").trim() || undefined };
  return { address: s.toLowerCase() };
}

interface ResendReceivedEmail {
  text?: string | null;
  html?: string | null;
  headers?: Record<string, string | string[]> | Array<{ name: string; value: string }> | null;
  from?: string | null;
  to?: string | string[] | null;
  subject?: string | null;
  message_id?: string | null;
}

interface ResendInboundPayload {
  type?: string;
  data?: {
    email_id?: string;
    message_id?: string;
    from?: string;
    to?: string[];
    cc?: string[];
    bcc?: string[];
    received_for?: string[];
    subject?: string;
    attachments?: { id?: string; filename?: string; content_type?: string }[];
  };
}

async function resendGet<T>(path: string, apiKey: string): Promise<T | null> {
  try {
    const res = await fetch(`${RESEND_API}${path}`, { headers: { authorization: `Bearer ${apiKey}` } });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** Pull a header value out of Resend's headers (object map OR name/value array), case-insensitive. */
function headerValue(headers: ResendReceivedEmail["headers"], name: string): string | undefined {
  if (!headers) return undefined;
  const want = name.toLowerCase();
  if (Array.isArray(headers)) return headers.find((x) => String(x.name).toLowerCase() === want)?.value;
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === want) {
      const v = (headers as Record<string, string | string[]>)[k];
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}

function asArray(v: string | string[] | null | undefined): string[] {
  return v ? (Array.isArray(v) ? v : [v]) : [];
}

// Crude HTML→text fallback for received emails that carry no plaintext part.
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Handle a verified Resend `email.received` event: fetch the parsed body + attachments back from
 * Resend, resolve the tenant from the recipient (direct-MX puts the +t.<token> address in `to`; a
 * forward puts the original in `received_for` / a Delivered-To header), then ingest via the shared
 * inbound spine. Body/attachment fetch is best-effort — a ticket still lands from the webhook
 * metadata + threading token even if the fetch-back hiccups.
 */
export async function ingestResendInbound(
  payload: ResendInboundPayload,
  opts?: { apiKey?: string | null; tenantId?: string; supportAddress?: string | null },
): Promise<ResendInboundResult> {
  if (payload?.type && payload.type !== "email.received") return { status: 200, ingested: false, reason: "ignored-event" };
  const data = payload?.data ?? {};
  const emailId = data.email_id;
  if (!emailId) return { status: 400, ingested: false, reason: "missing email_id" };
  // BYO: the per-tenant inbound route passes the tenant's own key; the shared route falls back to env.
  const apiKey = opts?.apiKey ?? process.env.RESEND_API_KEY;
  if (!apiKey) return { status: 503, ingested: false, reason: "RESEND_API_KEY not set" };

  // One fetch serves the body, the echo-guard headers, and forwarding-recipient fallbacks.
  const email = await resendGet<ResendReceivedEmail>(`/emails/receiving/${encodeURIComponent(emailId)}`, apiKey);

  // Echo guard: never re-ingest our own outbound (tagged X-Noola-Origin) if it ever loops back.
  if (email && headerValue(email.headers, ORIGIN_HEADER)) return { status: 200, ingested: false, reason: "own-outbound" };

  // Pick the recipient that maps to a tenant support route. Order of candidates spans direct-MX
  // (token address in `to`) and forwarding (original in received_for / Delivered-To / X-Original-To).
  const candidates = [
    ...(data.to ?? []), ...(data.cc ?? []), ...(data.bcc ?? []), ...(data.received_for ?? []),
    ...asArray(email?.to),
    headerValue(email?.headers, "delivered-to") ?? "",
    headerValue(email?.headers, "x-original-to") ?? "",
  ].map((a) => parseAddress(a).address).filter(Boolean);
  // BYO handle path: the tenant is already fixed by the per-tenant :handle in the URL, so we never gate
  // on the address table — a first-time sender lands as a lead + ticket even if the recipient address
  // isn't pre-registered. Address only steers reply-token threading + the stored `to`. Shared lane (no
  // tenantId): keep resolving by address, since one URL serves all tenants and an unrouted recipient
  // genuinely has no owner.
  let toAddr: string | null = null;
  if (opts?.tenantId) {
    const supportBase = opts.supportAddress ? parseInboundAddress(opts.supportAddress).base.toLowerCase() : null;
    toAddr =
      candidates.find((c) => supportBase && parseInboundAddress(c).base.toLowerCase() === supportBase) ??
      candidates.find((c) => parseInboundAddress(c).ticketId) ??
      candidates[0] ??
      opts.supportAddress ??
      null;
  } else {
    for (const cand of candidates) {
      if (await resolveTenantByAddress(parseInboundAddress(cand).base)) { toAddr = cand; break; }
    }
  }
  if (!toAddr) return { status: 202, ingested: false, reason: "no tenant route" };

  const body = email?.text && email.text.trim() ? email.text : email?.html ? htmlToText(email.html) : "";
  const from = parseAddress(data.from ?? email?.from);
  const cc = [...(data.to ?? []), ...(data.cc ?? []), ...asArray(email?.to)]
    .map((a) => parseAddress(a).address)
    .filter((a) => a && a !== toAddr && a !== from.address);

  // Fetch each attachment's bytes via its signed download_url (webhook lists metadata only).
  const files: NonNullable<InboundEmail["attachments"]> = [];
  for (const att of (data.attachments ?? []).slice(0, INBOUND_ATTACH_MAX_FILES)) {
    if (!att?.id) continue;
    const meta = await resendGet<{ download_url?: string; filename?: string; content_type?: string; size?: number }>(
      `/emails/receiving/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(att.id)}`,
      apiKey,
    );
    if (!meta?.download_url || (meta.size ?? 0) > INBOUND_ATTACH_MAX_BYTES) continue;
    try {
      const dl = await fetch(meta.download_url);
      if (!dl.ok) continue;
      const buf = Buffer.from(await dl.arrayBuffer());
      if (!buf.byteLength || buf.byteLength > INBOUND_ATTACH_MAX_BYTES) continue;
      files.push({
        filename: att.filename || meta.filename || "file",
        contentType: att.content_type || meta.content_type || "application/octet-stream",
        data: buf,
      });
    } catch {
      /* skip this file */
    }
  }

  const result: IngestResult | null = await handleInboundEmail(
    {
      messageId: data.message_id || email?.message_id || emailId,
      from: from.address,
      fromName: from.name,
      to: toAddr,
      subject: data.subject ?? email?.subject ?? "",
      body,
      ...(cc.length ? { cc: [...new Set(cc)] } : {}),
      ...(files.length ? { attachments: files } : {}),
    },
    opts?.tenantId ? { tenantId: opts.tenantId } : undefined,
  );
  return { status: result ? 201 : 202, ingested: !!result, ticketId: result?.ticketId ?? null };
}
