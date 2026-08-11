import { createHash } from "node:crypto";
import {
  handleInboundEmail,
  parseInboundAddress,
  ORIGIN_HEADER,
  type InboundEmail,
} from "./email.js";
import { parseAddress } from "./resend-inbound.js";
import type { IngestResult } from "./ingest.js";

// SendGrid Inbound Parse integration. Unlike Resend (metadata-only + Svix signature), SendGrid POSTs
// the FULL parsed email as multipart/form-data — body inline, attachment bytes inline — so there's no
// fetch-back and no signature: the unguessable per-tenant :handle in the URL IS the shared secret. We
// normalize the form fields (+ files) and hand off to the SAME handleInboundEmail() spine every other
// inbound path uses, so routing (per-ticket reply tokens, contact threading, idempotency by
// Message-ID) is identical.
//
// SendGrid form fields we read: envelope (JSON {to:[],from}), to/from/cc (header values), subject,
// text, html, headers (raw header blob — Message-ID + the X-Noola-Origin echo guard + forwarding
// Delivered-To/X-Original-To), attachments (count) + attachmentN files.

const INBOUND_ATTACH_MAX_BYTES = 10 * 1024 * 1024;
const INBOUND_ATTACH_MAX_FILES = 10;

export interface SendgridPart {
  filename?: string;
  contentType?: string;
  data: Buffer;
}

export interface SendgridInboundResult {
  status: number;
  ingested: boolean;
  ticketId?: string | null;
  reason?: string;
  // diagnostics for the route's structured log — so a future drop is a one-line read, not a debug loop
  from?: string;
  recipient?: string | null;
  candidates?: string[];
  rawMime?: boolean;
}

/** Read a single-line header value out of SendGrid's raw `headers` blob (case-insensitive). */
function headerFromBlob(blob: string | undefined, name: string): string | undefined {
  if (!blob) return undefined;
  const m = new RegExp(`^${name.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}:\\s*(.*)$`, "im").exec(blob);
  return m ? m[1].trim() : undefined;
}

/** Split a header address list ("A" <a@x>, b@y) into parsed addresses. */
function parseAddressList(v: string | undefined): { address: string; name?: string }[] {
  if (!v) return [];
  return v.split(",").map((s) => parseAddress(s)).filter((a) => a.address);
}

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
 * Normalize a SendGrid Inbound Parse payload (already parsed into fields + files by the multipart
 * route) and ingest via the shared inbound spine.
 *
 * The tenant is NOT derived from the recipient — the caller already resolved it from the per-tenant
 * inbound :handle in the URL (the handle IS the routing key, like Intercom's connected inbox), and
 * passes it in `opts.tenantId`. So a first-time sender to a workspace's address always lands as a new
 * lead + ticket, even if that exact recipient address was never pre-registered as a route. The
 * recipient is used only to (a) carry a +ticket reply token for exact-ticket threading and (b) fill
 * the stored `to` — we prefer a candidate matching the workspace's support address, else any
 * candidate, else the support address itself.
 */
export async function ingestSendgridInbound(
  fields: Record<string, string>,
  files: SendgridPart[],
  opts: { tenantId: string; supportAddress: string | null },
): Promise<SendgridInboundResult> {
  const headers = fields.headers;
  // Echo guard: our own outbound carries X-Noola-Origin — never re-ingest it if it ever loops back.
  if (headerFromBlob(headers, ORIGIN_HEADER)) return { status: 200, ingested: false, reason: "own-outbound" };

  // Recipient candidates, best-routing first: SMTP envelope RCPT TO, then the To header, then the
  // forwarding original (Delivered-To / X-Original-To) so a forwarded support@ still resolves.
  let envTo: string[] = [];
  try {
    const env = JSON.parse(fields.envelope ?? "{}") as { to?: unknown };
    if (Array.isArray(env.to)) envTo = env.to.map((x) => String(x));
  } catch { /* no/!json envelope */ }
  const candidates = [
    ...envTo,
    ...parseAddressList(fields.to).map((a) => a.address),
    headerFromBlob(headers, "delivered-to") ?? "",
    headerFromBlob(headers, "x-original-to") ?? "",
  ].map((a) => parseAddress(a).address).filter(Boolean);

  const from = parseAddress(fields.from);

  // Raw-MIME guard: if "POST the raw, full MIME message" is ticked in Inbound Parse, SendGrid sends a
  // single `email` field of raw RFC822 instead of parsed fields — so there's no from/to/text to work
  // with. Detect it explicitly and surface an actionable reason rather than a silent empty ingest.
  const rawMime = !fields.envelope && !fields.to && !fields.from && !fields.text && !fields.html && !!fields.email;
  if (rawMime || !from.address) {
    return { status: 202, ingested: false, reason: rawMime ? "raw-mime-unsupported" : "empty-sender", from: from.address, candidates, rawMime };
  }

  // Pick the recipient to store / thread on. The tenant is already fixed by the handle, so this only
  // steers reply-token threading and the displayed `to` — never whether we ingest.
  const supportBase = opts.supportAddress ? parseInboundAddress(opts.supportAddress).base.toLowerCase() : null;
  const toAddr =
    candidates.find((c) => supportBase && parseInboundAddress(c).base.toLowerCase() === supportBase) ??
    candidates.find((c) => parseInboundAddress(c).ticketId) ??
    candidates[0] ??
    opts.supportAddress ??
    from.address; // last resort: something non-empty so parseInboundAddress downstream is safe
  const body = fields.text && fields.text.trim() ? fields.text : fields.html ? htmlToText(fields.html) : "";
  const cc = [...parseAddressList(fields.cc), ...parseAddressList(fields.to)]
    .map((a) => a.address)
    .filter((a) => a && a !== toAddr && a !== from.address);

  // Message-ID is the idempotency key; SendGrid includes it in the raw headers. Fall back to a stable
  // hash of the salient fields so a header-less message still dedupes deterministically.
  const midHeader = headerFromBlob(headers, "message-id")?.replace(/^<|>$/g, "");
  const messageId =
    midHeader ||
    `sg:${createHash("sha256").update(`${from.address}\n${fields.subject ?? ""}\n${body}`).digest("hex").slice(0, 32)}`;

  const attachments: NonNullable<InboundEmail["attachments"]> = files
    .filter((f) => f.data?.byteLength && f.data.byteLength <= INBOUND_ATTACH_MAX_BYTES)
    .slice(0, INBOUND_ATTACH_MAX_FILES)
    .map((f) => ({
      filename: f.filename || "file",
      contentType: f.contentType || "application/octet-stream",
      data: f.data,
    }));

  const result: IngestResult | null = await handleInboundEmail(
    {
      messageId,
      from: from.address,
      fromName: from.name,
      to: toAddr,
      subject: fields.subject ?? "",
      body,
      ...(cc.length ? { cc: [...new Set(cc)] } : {}),
      ...(attachments.length ? { attachments } : {}),
    },
    { tenantId: opts.tenantId },
  );
  return {
    status: result ? 201 : 202,
    ingested: !!result,
    ticketId: result?.ticketId ?? null,
    from: from.address,
    recipient: toAddr,
    candidates,
    ...(result ? {} : { reason: "ingest-null" }),
  };
}
