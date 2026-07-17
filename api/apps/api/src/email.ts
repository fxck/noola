import crypto from "node:crypto";
import nodemailer from "nodemailer";
import { relayPool, withTenant } from "@repo/db";
import { ingestInbound, type IngestResult } from "./ingest.js";
import { persistBufferAttachments } from "./attachments.js";
import { renderReplyEmail } from "./emails/reply-email.js";
import { prodSecret } from "./prod-secret.js";

// The email channel — the second real channel after Discord, riding the same
// ingestInbound() spine. Dev/stage use Mailpit (SMTP catch + HTTP API); a real
// ESP goes behind this same seam at prod (swap SMTP_HOST / the poll source).
//
// Tenant resolution keys on the RECIPIENT (To) address — a tenant's support
// inbox — via email_routes (unpolicied, BYPASSRLS relay, resolved before any
// tenant context). The customer's From address keys the ticket (one thread per
// customer). Idempotency is the email Message-ID.

// Our own outbound is tagged so the inbound poller can never re-ingest it
// (belt-and-suspenders on top of "To=customer resolves to no tenant route").
const ORIGIN_HEADER = "X-Noola-Origin";
// Env is read at call time (not module load) so behavior tracks the live config
// and tests can exercise the enabled/disabled paths deterministically.

// ---- tenant routing (unpolicied, like discord_links) --------------------

/** Resolve a tenant from the inbound recipient (support) address. */
export async function resolveTenantByAddress(address: string): Promise<string | null> {
  const r = await relayPool.query(
    "SELECT tenant_id FROM email_routes WHERE address = $1",
    [address.toLowerCase()],
  );
  return r.rowCount ? (r.rows[0].tenant_id as string) : null;
}

/** Bind a support address to a tenant (onboarding). */
export async function linkEmailRoute(address: string, tenantId: string): Promise<void> {
  await relayPool.query(
    "INSERT INTO email_routes (address, tenant_id) VALUES ($1, $2) ON CONFLICT (address) DO UPDATE SET tenant_id = EXCLUDED.tenant_id",
    [address.toLowerCase(), tenantId],
  );
}

/** The tenant's own support address (outbound From, so replies round-trip back). */
async function tenantSupportAddress(tenantId: string): Promise<string | null> {
  const r = await relayPool.query(
    "SELECT address FROM email_routes WHERE tenant_id = $1 ORDER BY created_at ASC LIMIT 1",
    [tenantId],
  );
  return r.rowCount ? (r.rows[0].address as string) : null;
}

// ---- per-conversation reply addressing (P4) ------------------------------
// Outbound replies set a SIGNED plus-address reply-to (support+t.<ticketid>.<sig>@domain) so a
// customer's reply routes to the EXACT ticket — not merged by sender (a contact with two open
// tickets replying to one previously landed on whichever conversation was open). The token is
// self-authenticating (HMAC over the ticket uuid) — no schema, no lookup table; inbound verifies
// the signature before trusting the id. Threading headers (Message-ID / In-Reply-To / References)
// ride along so mail clients keep the conversation in one visual thread.

/** The one SMTP transport factory. Dev/stage: bare Mailpit (no auth, no TLS). Prod: a real ESP
 *  relay — SMTP_USER/SMTP_PASS enable AUTH, SMTP_SECURE=1 (or port 465) enables implicit TLS;
 *  587 submission works via STARTTLS (nodemailer upgrades automatically when the server offers). */
function smtpTransport(host: string, port: number): nodemailer.Transporter {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  return nodemailer.createTransport({
    host,
    port,
    secure: process.env.SMTP_SECURE === "1" || port === 465,
    ...(user && pass ? { auth: { user, pass } } : {}),
  });
}

function emailTokenSecret(): string {
  return prodSecret(
    "EMAIL_TOKEN_SECRET (or AUTH_SECRET)",
    process.env.EMAIL_TOKEN_SECRET || process.env.AUTH_SECRET,
    "dev-insecure-secret-change-me",
  );
}

function tokenSig(idHex: string): string {
  return crypto.createHmac("sha256", emailTokenSecret()).update(idHex).digest("hex").slice(0, 10);
}

/** Signed per-ticket reply token: `<uuid-without-dashes>.<sig10>`. */
export function ticketEmailToken(ticketId: string): string {
  const id = ticketId.replace(/-/g, "").toLowerCase();
  return `${id}.${tokenSig(id)}`;
}

/** The per-conversation reply address derived from the tenant's support address. */
export function ticketReplyAddress(supportAddress: string, ticketId: string): string {
  const [local, domain] = supportAddress.split("@");
  return `${local}+t.${ticketEmailToken(ticketId)}@${domain}`;
}

/** Parse an inbound recipient. Returns the base (route) address plus the VERIFIED ticket id when
 *  the address carries a valid `+t.<id>.<sig>` token; a bad/forged signature yields ticketId null
 *  (and routes by the base address like any other mail). Foreign plus-tags are stripped for the
 *  base so `support+whatever@` still routes to the tenant. */
export function parseInboundAddress(address: string): { base: string; ticketId: string | null } {
  const a = address.trim();
  const m = /^([^+@]+)\+t\.([0-9a-f]{32})\.([0-9a-f]{10})@(.+)$/i.exec(a);
  if (m) {
    const [, local, idRaw, sig, domain] = m;
    const id = idRaw.toLowerCase();
    const base = `${local}@${domain}`.toLowerCase();
    try {
      if (crypto.timingSafeEqual(Buffer.from(sig.toLowerCase()), Buffer.from(tokenSig(id)))) {
        const uuid = `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
        return { base, ticketId: uuid };
      }
    } catch { /* length mismatch — treat as unsigned */ }
    return { base, ticketId: null };
  }
  const g = /^([^+@]+)(\+[^@]*)?@(.+)$/.exec(a);
  return { base: g ? `${g[1]}@${g[3]}`.toLowerCase() : a.toLowerCase(), ticketId: null };
}

/** Angle-bracket-normalize an RFC 5322 Message-ID for In-Reply-To/References. */
function angled(messageId: string): string {
  const v = messageId.trim();
  return v.startsWith("<") ? v : `<${v}>`;
}

// ---- inbound seam (testable without Mailpit) ----------------------------

export interface InboundEmail {
  messageId: string; // email Message-ID header — the idempotency key
  from: string; // customer address — the cross-channel identity + reply target
  fromName?: string; // customer display name (From header), when present
  to: string; // tenant support address — resolves the tenant
  subject: string;
  body: string;
  /** Other recipients on the email (Cc + extra To, minus the support route) — stamped on the
   *  message's meta so the agent composer can default to reply-all. */
  cc?: string[];
  /** Raw file attachments from the email — persisted into object-storage onto the message. */
  attachments?: { filename: string; contentType: string; data: Buffer }[];
}

/** Post-ingest finish for an inbound email: persist attachments onto the message and stamp the
 *  cc list into the message meta (both best-effort — a hiccup never loses the ticket). */
async function finishInboundEmail(result: IngestResult, m: InboundEmail): Promise<void> {
  if (m.attachments?.length) {
    await persistBufferAttachments(result.tenantId, result.ticketId, result.messageId, m.attachments.slice(0, 10))
      .catch(() => {});
  }
  if (m.cc?.length) {
    await withTenant(result.tenantId, async (c) => {
      await c.query(
        `UPDATE messages SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('cc', $2::jsonb) WHERE id = $1`,
        [result.messageId, JSON.stringify(m.cc!.slice(0, 10))],
      );
    }).catch(() => {});
  }
}

/**
 * Resolve the recipient's tenant, then ingest into ticket+message+outbox.
 * Returns null when the To address maps to no tenant — which is also the echo
 * guard: our own outbound (To = the customer) resolves to nothing, so it can
 * never loop back into a ticket. The Message-ID is the idempotency key, so a
 * re-polled message dedupes for free.
 */
export async function handleInboundEmail(m: InboundEmail): Promise<IngestResult | null> {
  const parsed = parseInboundAddress(m.to);
  const tenantId = await resolveTenantByAddress(parsed.base);
  if (!tenantId) return null;

  // Exact-ticket routing (P4): a verified reply-to token beats From-address threading — the reply
  // lands on THAT ticket (reopening it if it closed meanwhile), so a contact with several open
  // conversations can answer each one's email correctly. Token invalid / ticket gone → fall
  // through to the normal contact threading below.
  if (parsed.ticketId) {
    const exists = await withTenant(tenantId, async (c) => {
      const r = await c.query("SELECT status FROM tickets WHERE id = $1", [parsed.ticketId]);
      if (!r.rowCount) return false;
      if ((r.rows[0].status as string) !== "open") {
        await c.query("UPDATE tickets SET status = 'open', updated_at = now() WHERE id = $1", [parsed.ticketId]);
      }
      return true;
    }).catch(() => false);
    if (exists) {
      const result = await ingestInbound({
        tenantId,
        ticketId: parsed.ticketId,
        body: m.body,
        authorType: "customer",
        idempotencyKey: `email:${m.messageId}`,
        subject: m.subject || m.body.slice(0, 80),
        channelType: "email",
        externalChannelId: m.from.toLowerCase(),
        identity: { email: m.from.toLowerCase(), name: m.fromName ?? null },
      });
      if (!result.replay) await finishInboundEmail(result, m);
      return result;
    }
  }

  const result = await ingestInbound({
    tenantId,
    body: m.body,
    authorType: "customer",
    idempotencyKey: `email:${m.messageId}`,
    subject: m.subject || m.body.slice(0, 80),
    channelType: "email",
    externalChannelId: m.from.toLowerCase(),
    // The From address is both the reply target and the cross-channel identity (email unifies).
    identity: { email: m.from.toLowerCase(), name: m.fromName ?? null },
  });
  // A replayed (idempotency-deduped) message already carried its files/cc the first time.
  if (!result.replay) await finishInboundEmail(result, m);
  return result;
}

// ---- outbound seam ------------------------------------------------------

/**
 * The single outbound-SMTP primitive — the ONE place we touch nodemailer. Sends one
 * email via the configured transport (Mailpit in dev). From = the tenant's support
 * address (so a reply round-trips back), tagged with the origin header so the inbound
 * poller never re-ingests it. Subject is sent VERBATIM (callers that want reply
 * semantics prepend "Re:" themselves). No-ops (with a reason) when there's no recipient
 * or SMTP is unset, returning the same delivered/reason shape as the ticket-reply seam,
 * so a caller can log per-send. Reused by routeEmailOutbound (ticket replies) and the
 * broadcast mass-send. Env: SMTP_HOST (channel toggle), SMTP_PORT (default 1025).
 */
export async function sendOutboundEmail(
  tenantId: string,
  to: string | null | undefined,
  subject: string,
  body: string,
  opts?: {
    html?: string; attachments?: MailAttachment[]; unsubscribeUrl?: string;
    /** Carbon-copy recipients (reply-all) — sent verbatim on the same message. */
    cc?: string[];
    /** Per-conversation addressing (P4): sets the signed reply-to + a deterministic Message-ID. */
    replyToTicketId?: string | null;
    /** The customer's last email Message-ID — threads the reply in their mail client. */
    inReplyTo?: string | null;
  },
): Promise<{ delivered: boolean; reason?: string }> {
  if (!to) return { delivered: false, reason: "no-recipient" };
  const smtpHost = process.env.SMTP_HOST;
  if (!smtpHost) return { delivered: false, reason: "email-disabled" };
  const smtpPort = Number(process.env.SMTP_PORT ?? 1025);
  const from = (await tenantSupportAddress(tenantId)) ?? "support@noola.local";
  const fromDomain = from.split("@")[1] ?? "noola.local";
  const tx = smtpTransport(smtpHost, smtpPort);
  await tx.sendMail({
    from,
    to,
    ...(opts?.cc?.length ? { cc: opts.cc } : {}),
    subject,
    text: body,
    ...(opts?.replyToTicketId
      ? {
          replyTo: ticketReplyAddress(from, opts.replyToTicketId),
          messageId: `<t.${ticketEmailToken(opts.replyToTicketId)}.${Date.now().toString(36)}@${fromDomain}>`,
        }
      : {}),
    ...(opts?.inReplyTo ? { inReplyTo: angled(opts.inReplyTo), references: angled(opts.inReplyTo) } : {}),
    // A rich HTML alternative (React Email render) when the caller supplies one — mail clients that
    // can, show it; plaintext `text` stays the fallback. Attachments ride the same nodemailer send.
    ...(opts?.html ? { html: opts.html } : {}),
    ...(opts?.attachments?.length ? { attachments: opts.attachments } : {}),
    headers: {
      [ORIGIN_HEADER]: "agent",
      // Marketing sends (broadcasts) carry the RFC 2369/8058 opt-out headers so mail clients
      // surface their native "Unsubscribe" affordance; the POST target is the one-click lane.
      ...(opts?.unsubscribeUrl
        ? {
            "List-Unsubscribe": `<${opts.unsubscribeUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          }
        : {}),
    },
  });
  return { delivered: true };
}

/** A file attached to an outbound email (nodemailer's attachment shape, narrowed to what we send). */
export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

/**
 * Send a transactional AUTH email (workspace invitation, etc.) over the same SMTP transport
 * (Mailpit in dev/stage). Unlike sendOutboundEmail this is NOT tenant-support-routed — the
 * From is a fixed system address (AUTH_EMAIL_FROM) — because an invite isn't a ticket reply
 * and mustn't depend on the tenant having a support route. Carries the origin tag so the
 * inbound poller ignores it (never re-ingested as a ticket). No-ops (with a reason) when SMTP
 * is unset, so a setup without email still functions (the link is also returned via the API).
 */
export async function sendAuthEmail(
  to: string,
  subject: string,
  body: string,
): Promise<{ delivered: boolean; reason?: string }> {
  const smtpHost = process.env.SMTP_HOST;
  if (!smtpHost) return { delivered: false, reason: "email-disabled" };
  const smtpPort = Number(process.env.SMTP_PORT ?? 1025);
  const from = process.env.AUTH_EMAIL_FROM ?? "no-reply@noola.local";
  try {
    const tx = smtpTransport(smtpHost, smtpPort);
    await tx.sendMail({ from, to, subject, text: body, headers: { [ORIGIN_HEADER]: "auth" } });
    return { delivered: true };
  } catch (err) {
    // Never let a mail hiccup fail the invite/account operation this rides inside — the link
    // is also returned via the API, so delivery is best-effort.
    return { delivered: false, reason: `send-failed: ${(err as Error).message}` };
  }
}

/**
 * Send an agent reply back to the customer as email. externalChannelId is the
 * customer's address (the ticket's origin). Rides sendOutboundEmail with reply
 * semantics (a "Re:" prefix unless the subject already carries one). The markdown
 * body is rendered through the React Email reply template — HTML alternative +
 * markdown-stripped plaintext; if rendering fails, falls back to the raw markdown
 * with no HTML (a render hiccup never blocks the send). No-ops (with a reason)
 * when the channel is disabled or there's no recipient.
 */
export async function routeEmailOutbound(
  routing: { tenantId: string; externalChannelId?: string | null; ticketId?: string | null },
  subject: string,
  body: string,
  attachments?: MailAttachment[],
  opts?: { agentName?: string | null; cc?: string[] },
): Promise<{ delivered: boolean; reason?: string }> {
  const subj = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
  // The tenant's flagged reply template (0072) restyles the frame; failures fall back to the
  // stock personal look — a designer hiccup never blocks the send.
  const tokens = await import("./email-templates.js")
    .then((m) => m.getReplyTemplateTokens(routing.tenantId))
    .catch(() => null);
  const rendered = await renderReplyEmail(body, { ...opts, tokens }).catch(() => null);
  // P4 threading: reference the customer's last inbound email so their client threads the reply
  // (In-Reply-To/References), and reply-to the signed per-ticket address so THEIR reply routes to
  // exactly this conversation. Both best-effort — a lookup hiccup never blocks the send.
  const inReplyTo = routing.ticketId
    ? await withTenant(routing.tenantId, async (c) => {
        const r = await c.query(
          `SELECT idempotency_key FROM messages
            WHERE ticket_id = $1 AND author_type = 'customer' AND channel_type = 'email'
              AND idempotency_key LIKE 'email:%'
            ORDER BY created_at DESC LIMIT 1`,
          [routing.ticketId],
        );
        return r.rowCount ? (r.rows[0].idempotency_key as string).slice("email:".length) : null;
      }).catch(() => null)
    : null;
  return sendOutboundEmail(routing.tenantId, routing.externalChannelId, subj, rendered?.text || body, {
    ...(rendered?.html ? { html: rendered.html } : {}),
    ...(attachments?.length ? { attachments } : {}),
    ...(opts?.cc?.length ? { cc: opts.cc } : {}),
    replyToTicketId: routing.ticketId ?? null,
    inReplyTo,
  });
}

// ---- inbound poller (Mailpit; validated live) ---------------------------

type Log = { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

interface MailpitListItem { ID: string; Read: boolean }
interface MailpitMessage {
  ID: string;
  MessageID: string;
  From: { Address: string; Name: string };
  To: { Address: string; Name: string }[];
  Cc?: { Address: string; Name: string }[] | null;
  Subject: string;
  Text: string;
  Headers?: Record<string, string[]>;
  Attachments?: { PartID: string; FileName: string; ContentType: string; Size: number }[] | null;
}

// Per-file / per-message caps for inbound attachment ingestion — matches the widget's ceiling.
const INBOUND_ATTACH_MAX_BYTES = 10 * 1024 * 1024;
const INBOUND_ATTACH_MAX_FILES = 10;

async function markRead(api: string, ids: string[]): Promise<void> {
  await fetch(`${api}/api/v1/messages`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ IDs: ids, Read: true }),
  });
}

/**
 * Poll Mailpit for unread messages and funnel each through the inbound seam.
 * Skips our own origin-tagged outbound; marks every processed message read so a
 * later poll won't reconsider it (idempotency backstops any race). Best-effort:
 * a transient Mailpit hiccup logs and the next tick retries.
 */
export async function pollEmail(log: Log): Promise<void> {
  const api = process.env.MAILPIT_API_URL;
  if (!api) return;
  let list: { messages: MailpitListItem[] };
  try {
    const res = await fetch(`${api}/api/v1/messages?limit=50`);
    if (!res.ok) throw new Error(`mailpit list ${res.status}`);
    list = (await res.json()) as { messages: MailpitListItem[] };
  } catch (err) {
    log.warn({ err }, "email: mailpit list failed");
    return;
  }
  for (const item of list.messages ?? []) {
    if (item.Read) continue;
    try {
      const full = (await (await fetch(`${api}/api/v1/message/${item.ID}`)).json()) as MailpitMessage;
      const origin = full.Headers?.[ORIGIN_HEADER]?.[0];
      if (origin) {
        await markRead(api, [item.ID]); // our own outbound — never ingest
        continue;
      }
      const to = (full.To?.[0]?.Address ?? "").toLowerCase();
      const from = (full.From?.Address ?? "").toLowerCase();
      // Everyone else on the email (Cc + extra To recipients) minus the support route itself —
      // the reply-all set the composer should default to.
      const cc = [...(full.To ?? []).slice(1), ...(full.Cc ?? [])]
        .map((a) => (a?.Address ?? "").toLowerCase())
        .filter((a) => a && a !== to && a !== from);
      // Download each attachment part from Mailpit (bytes ride the part endpoint).
      const files: { filename: string; contentType: string; data: Buffer }[] = [];
      for (const att of (full.Attachments ?? []).slice(0, INBOUND_ATTACH_MAX_FILES)) {
        if (!att?.PartID || (att.Size ?? 0) > INBOUND_ATTACH_MAX_BYTES) continue;
        try {
          const part = await fetch(`${api}/api/v1/message/${item.ID}/part/${att.PartID}`);
          if (!part.ok) continue;
          files.push({
            filename: att.FileName || "file",
            contentType: att.ContentType || part.headers.get("content-type") || "application/octet-stream",
            data: Buffer.from(await part.arrayBuffer()),
          });
        } catch { /* skip this file */ }
      }
      const r = await handleInboundEmail({
        messageId: full.MessageID || item.ID,
        from,
        fromName: full.From?.Name || undefined,
        to,
        subject: full.Subject ?? "",
        body: full.Text ?? "",
        ...(cc.length ? { cc: [...new Set(cc)] } : {}),
        ...(files.length ? { attachments: files } : {}),
      });
      await markRead(api, [item.ID]);
      if (!r) log.warn(`email: no tenant route for recipient ${to} — ignored`);
    } catch (err) {
      log.error({ err, id: item.ID }, "email: inbound ingest failed");
    }
  }
}
