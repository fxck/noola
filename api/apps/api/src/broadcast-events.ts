import { withTenant } from "@repo/db";

// Delivery-event ingestion — the outbound twin of resend-inbound.ts. Email providers (Resend,
// SendGrid) fire delivery-lifecycle webhooks for every send: delivered, bounced, complained
// (spam report), opened, clicked. This module turns one such event into three effects, all
// tenant-scoped and best-effort:
//   1. match it back to the broadcast_recipients row it belongs to,
//   2. advance that row's derived delivery status/timestamps (first-touch, never regressing a
//      terminal bounce/complaint back to 'delivered'),
//   3. append an immutable broadcast_events row (the analytics backbone), and for a HARD bounce
//      or a COMPLAINT, park the address in email_suppressions so future sends skip it (a
//      complaint also flips the known contact's marketing opt-out).
//
// Matching is provider-agnostic: prefer the exact Message-ID we stamped at send (round-tripped
// by the provider when it echoes headers), else fall back to the most-recent recipient for that
// address in the tenant. A recipient is deduped to at most one row per broadcast, and the same
// address rarely rides two broadcasts within seconds, so the address fallback is reliable for
// suppression; the Message-ID path is the precise one when available.

export type DeliveryEventType =
  | "sent"
  | "delivered"
  | "deferred"
  | "bounced"
  | "complained"
  | "opened"
  | "clicked"
  | "unsubscribed"
  | "failed";

export interface DeliveryEvent {
  type: DeliveryEventType;
  address?: string | null;
  /** Provider-echoed original Message-ID (the value we stamped at send), if present. */
  messageId?: string | null;
  /** For bounces: 'hard' (permanent → suppress) vs 'soft' (transient → do not suppress). */
  bounceKind?: "hard" | "soft" | null;
  broadcastId?: string | null;
  occurredAt?: Date | null;
  meta?: Record<string, unknown>;
}

export interface RecordResult {
  matched: boolean;
  recipientId: string | null;
  suppressed: boolean;
}

/** The per-recipient column mutation for an event type. Returns null for events that carry no
 *  recipient-status delta (e.g. a raw 'sent'/'failed' — those are stamped by the send loop). All
 *  writes are COALESCE first-touch, and status only advances (a delivered event never overwrites
 *  a prior bounced/complained/failed head). */
function recipientDelta(type: DeliveryEventType, bounceKind: "hard" | "soft" | null): { sql: string; params: unknown[] } | null {
  switch (type) {
    case "delivered":
      // Don't regress a terminal negative outcome that arrived out of order.
      return { sql: "status = CASE WHEN status IN ('bounced','complained','failed') THEN status ELSE 'delivered' END, delivered_at = COALESCE(delivered_at, now())", params: [] };
    case "bounced":
      return { sql: "status = 'bounced', bounced_at = COALESCE(bounced_at, now()), bounce_kind = COALESCE(bounce_kind, $2)", params: [bounceKind ?? "hard"] };
    case "complained":
      return { sql: "status = 'complained', complained_at = COALESCE(complained_at, now())", params: [] };
    case "opened":
      return { sql: "opened_at = COALESCE(opened_at, now())", params: [] };
    case "clicked":
      // A click implies an open even if the pixel never loaded.
      return { sql: "clicked_at = COALESCE(clicked_at, now()), opened_at = COALESCE(opened_at, now())", params: [] };
    case "unsubscribed":
      return { sql: "unsubscribed_at = COALESCE(unsubscribed_at, now())", params: [] };
    default:
      return null;
  }
}

export async function recordDeliveryEvent(tenantId: string, ev: DeliveryEvent): Promise<RecordResult> {
  const address = ev.address?.trim().toLowerCase() || null;
  return withTenant(tenantId, async (c) => {
    // 1. Match the recipient row. Message-ID first (exact), then latest recipient for the address.
    let rid: string | null = null;
    let bcastId: string | null = ev.broadcastId ?? null;
    let contactId: string | null = null;
    if (ev.messageId) {
      const m = await c.query(
        "SELECT id, broadcast_id, contact_id FROM broadcast_recipients WHERE message_id = $1 ORDER BY created_at DESC LIMIT 1",
        [ev.messageId],
      );
      if (m.rowCount) {
        rid = m.rows[0].id as string;
        bcastId = m.rows[0].broadcast_id as string;
        contactId = (m.rows[0].contact_id as string | null) ?? null;
      }
    }
    if (!rid && address) {
      const m = await c.query(
        "SELECT id, broadcast_id, contact_id FROM broadcast_recipients WHERE lower(handle) = $1 ORDER BY created_at DESC LIMIT 1",
        [address],
      );
      if (m.rowCount) {
        rid = m.rows[0].id as string;
        bcastId = m.rows[0].broadcast_id as string;
        contactId = (m.rows[0].contact_id as string | null) ?? null;
      }
    }

    // 2. Advance the recipient's derived status/timestamps.
    if (rid) {
      const delta = recipientDelta(ev.type, ev.bounceKind ?? null);
      if (delta) await c.query(`UPDATE broadcast_recipients SET ${delta.sql} WHERE id = $1`, [rid, ...delta.params]);
    }

    // 3. Append the immutable event.
    await c.query(
      "INSERT INTO broadcast_events (broadcast_id, recipient_id, contact_id, type, address, meta, occurred_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb, COALESCE($7, now()))",
      [bcastId, rid, contactId, ev.type, address, JSON.stringify(ev.meta ?? {}), ev.occurredAt ?? null],
    );

    // 4. Suppress permanent failures. A hard bounce or a spam complaint parks the address so no
    //    future send re-hits it; a complaint additionally opts the known contact out of marketing.
    let suppressed = false;
    const shouldSuppress = !!address && (ev.type === "complained" || (ev.type === "bounced" && (ev.bounceKind ?? "hard") !== "soft"));
    if (shouldSuppress && address) {
      const reason = ev.type === "complained" ? "complaint" : "hard_bounce";
      await c.query(
        `INSERT INTO email_suppressions (address, reason, broadcast_id, contact_id) VALUES ($1,$2,$3,$4)
           ON CONFLICT (tenant_id, address) DO UPDATE SET reason = EXCLUDED.reason, broadcast_id = COALESCE(email_suppressions.broadcast_id, EXCLUDED.broadcast_id), created_at = now()`,
        [address, reason, bcastId, contactId],
      );
      suppressed = true;
      if (ev.type === "complained" && contactId) {
        await c.query("UPDATE contacts SET unsubscribed_at = COALESCE(unsubscribed_at, now()) WHERE id = $1", [contactId]);
        if (rid) await c.query("UPDATE broadcast_recipients SET unsubscribed_at = COALESCE(unsubscribed_at, now()) WHERE id = $1", [rid]);
      }
    }

    return { matched: !!rid, recipientId: rid, suppressed };
  });
}

// ---- Suppression list management -----------------------------------------------------------

export interface SuppressionRow {
  address: string;
  reason: string;
  broadcast_id: string | null;
  created_at: string;
}

export async function listSuppressions(tenantId: string, limit = 1000): Promise<SuppressionRow[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      "SELECT address, reason, broadcast_id, created_at FROM email_suppressions ORDER BY created_at DESC LIMIT $1",
      [limit],
    );
    return r.rows as SuppressionRow[];
  });
}

/** Manually park an address (reason 'manual'). Idempotent. */
export async function addSuppression(tenantId: string, address: string, reason = "manual"): Promise<boolean> {
  const addr = address.trim().toLowerCase();
  if (!addr) return false;
  return withTenant(tenantId, async (c) => {
    await c.query(
      `INSERT INTO email_suppressions (address, reason) VALUES ($1,$2)
         ON CONFLICT (tenant_id, address) DO UPDATE SET reason = EXCLUDED.reason, created_at = now()`,
      [addr, reason],
    );
    return true;
  });
}

/** Un-suppress an address (a fixed mailbox, a mistaken complaint). Returns whether a row was removed. */
export async function removeSuppression(tenantId: string, address: string): Promise<boolean> {
  const addr = address.trim().toLowerCase();
  return withTenant(tenantId, async (c) => {
    const r = await c.query("DELETE FROM email_suppressions WHERE address = $1", [addr]);
    return (r.rowCount ?? 0) > 0;
  });
}

// ---- Provider payload → normalized events ---------------------------------------------------

/** First present header value (case-insensitive) from Resend's headers shape (object or array). */
function headerFrom(headers: unknown, name: string): string | null {
  const want = name.toLowerCase();
  if (Array.isArray(headers)) {
    for (const h of headers as Array<{ name?: string; value?: string }>) {
      if (typeof h?.name === "string" && h.name.toLowerCase() === want) return h.value ?? null;
    }
  } else if (headers && typeof headers === "object") {
    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
      if (k.toLowerCase() === want) return Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "");
    }
  }
  return null;
}

/** Strip the angle brackets a Message-ID travels in, so it matches the stamped bare form. */
function unangle(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.trim().replace(/^<|>$/g, "");
  return s || null;
}

/**
 * Normalize a Resend delivery webhook (`email.delivered` / `email.bounced` / `email.complained` /
 * `email.opened` / `email.clicked` / `email.delivery_delayed`). One event → zero or one
 * DeliveryEvent (opened/clicked/delivered/bounced/complained mapped; unknown types dropped).
 * Resend puts the recipient in `data.to` (array). Bounce hardness: `data.bounce.type`
 * ('Permanent' → hard, 'Transient' → soft).
 */
export function parseResendDeliveryEvent(payload: unknown): DeliveryEvent | null {
  const p = payload as { type?: string; created_at?: string; data?: Record<string, unknown> } | null;
  if (!p?.type || !p.type.startsWith("email.")) return null;
  const data = p.data ?? {};
  const to = data.to;
  const address = Array.isArray(to) ? (to[0] as string | undefined) : (to as string | undefined);
  const messageId = unangle(headerFrom(data.headers, "message-id")) ?? (typeof data.message_id === "string" ? unangle(data.message_id) : null);
  const at = p.created_at ? new Date(p.created_at) : null;
  const base = { address: address ?? null, messageId, occurredAt: at && !Number.isNaN(at.getTime()) ? at : null, meta: { provider: "resend", raw_type: p.type } as Record<string, unknown> };
  switch (p.type) {
    case "email.delivered":
      return { type: "delivered", ...base };
    case "email.delivery_delayed":
      return { type: "deferred", ...base };
    case "email.opened":
      return { type: "opened", ...base };
    case "email.clicked":
      return { type: "clicked", ...base };
    case "email.complained":
      return { type: "complained", ...base };
    case "email.bounced": {
      const bt = ((data.bounce as { type?: string } | undefined)?.type ?? "").toLowerCase();
      const bounceKind: "hard" | "soft" = bt.includes("transient") || bt.includes("soft") ? "soft" : "hard";
      return { type: "bounced", bounceKind, ...base };
    }
    default:
      return null;
  }
}

/**
 * Normalize ONE SendGrid Event Webhook object. SendGrid POSTs an ARRAY of these; the caller maps
 * over `parseSendgridDeliveryEvents`. `event` is delivered|bounce|dropped|spamreport|open|click|
 * deferred; `type` distinguishes a hard `bounce` from a soft `blocked`. `smtp-id` echoes the
 * Message-ID we stamped; `sg_message_id` is SendGrid's own id (unused for matching).
 */
function parseOneSendgridEvent(o: Record<string, unknown>): DeliveryEvent | null {
  const event = String(o.event ?? "").toLowerCase();
  const address = typeof o.email === "string" ? o.email : null;
  const messageId = unangle(typeof o["smtp-id"] === "string" ? (o["smtp-id"] as string) : null);
  const tsSec = typeof o.timestamp === "number" ? o.timestamp : Number(o.timestamp);
  const occurredAt = Number.isFinite(tsSec) ? new Date(tsSec * 1000) : null;
  const base = { address, messageId, occurredAt, meta: { provider: "sendgrid", raw_event: event } as Record<string, unknown> };
  switch (event) {
    case "delivered":
      return { type: "delivered", ...base };
    case "deferred":
      return { type: "deferred", ...base };
    case "open":
      return { type: "opened", ...base };
    case "click":
      return { type: "clicked", ...base };
    case "spamreport":
      return { type: "complained", ...base };
    case "bounce":
      // SendGrid 'type' = 'bounce' (hard) vs 'blocked' (soft/transient).
      return { type: "bounced", bounceKind: String(o.type ?? "").toLowerCase() === "blocked" ? "soft" : "hard", ...base };
    case "dropped":
      // Pre-send drop (invalid, already-bounced, unsub-group) — treat as a hard failure to suppress.
      return { type: "bounced", bounceKind: "hard", ...base };
    default:
      return null;
  }
}

export function parseSendgridDeliveryEvents(payload: unknown): DeliveryEvent[] {
  if (!Array.isArray(payload)) return [];
  const out: DeliveryEvent[] = [];
  for (const o of payload) {
    if (o && typeof o === "object") {
      const ev = parseOneSendgridEvent(o as Record<string, unknown>);
      if (ev) out.push(ev);
    }
  }
  return out;
}
