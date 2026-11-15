import { setTicketSpam } from "./tickets.js";
import { setContactSpam, contactLiveTicketCount } from "./contacts.js";
import { withTenant } from "@repo/db";
import { blockSender, unblockByHandle, type BlockScope } from "./blocklist.js";
import { getSpamSettings } from "./spam-check.js";

// The one "mark as spam" orchestration, shared by the web route (POST /tickets/:id/spam) and the
// Discord ops-mirror 🚫 reaction — so both do exactly the same thing: soft-hide the ticket, block the
// sender (before it can create more tickets), and drop the lead the ticket auto-created. All reversible.

export interface SpamOptions {
  block?: boolean;
  blockScope?: BlockScope;
  dropLead?: boolean;
  actorId?: string | null;
}

/** Mark a conversation as spam. Returns the applied outcome, or null when the ticket doesn't exist. */
export async function markConversationSpam(
  tenantId: string,
  ticketId: string,
  opts: SpamOptions,
): Promise<{ ticketId: string; blocked: string | null; leadDropped: boolean } | null> {
  const out = await setTicketSpam(tenantId, ticketId, true);
  if (!out) return null;

  let blocked: string | null = null;
  if (opts.block && out.senderHandle) {
    const row = await blockSender(tenantId, {
      // Only an e-mail address has a domain worth blocking. A widget ban holds a user id or the visitor's own e-mail.
      channelType: out.channelType, scope: out.channelType === "email" ? opts.blockScope ?? "address" : "address", handle: out.senderHandle,
      reason: "marked spam", createdBy: opts.actorId ?? null,
    }).catch(() => null);
    blocked = row?.handle ?? null;
  } else if (out.senderHandle) {
    blocked = await blockRepeatSender(tenantId, out.channelType, out.senderHandle).catch(() => null);
  }

  // Drop the lead only when this spam ticket was the contact's ONLY conversation.
  let leadDropped = false;
  if (opts.dropLead && out.contactId && (await contactLiveTicketCount(tenantId, out.contactId)) === 0) {
    await setContactSpam(tenantId, out.contactId, true).catch(() => {});
    leadDropped = true;
  }

  // Reflect the spam onto Discord (best-effort, fire-and-forget): notice + archive the ops-mirror post,
  // so a spammed conversation doesn't linger as an open thread. Dynamic import breaks the
  // discord-mirror ↔ spam module cycle. No-ops when the ticket isn't mirrored.
  void import("./discord-mirror.js")
    .then((m) => m.onConversationSpam(tenantId, ticketId, { actorId: opts.actorId ?? null, blocked: blocked !== null }))
    .catch(() => {});

  return { ticketId: out.ticketId, blocked, leadDropped };
}

async function announceRestoredTicket(tenantId: string, ticketId: string): Promise<void> {
  const seed = await withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT t.subject, t.channel_type, m.id AS message_id, m.body
         FROM tickets t
         LEFT JOIN LATERAL (SELECT id, body FROM messages
                             WHERE tenant_id = t.tenant_id AND ticket_id = t.id AND author_type = 'customer'
                             ORDER BY created_at LIMIT 1) m ON true
        WHERE t.id = $1`,
      [ticketId],
    );
    const t = r.rows[0];
    return t && { ticketId, messageId: t.message_id, subject: t.subject, body: t.body ?? "", channelType: t.channel_type, authorType: "customer" };
  });
  if (!seed) return;
  const { emitDomainEvent } = await import("./automations.js");
  emitDomainEvent(tenantId, "ticket.created", seed);
  const { fireEvent } = await import("./webhooks.js");
  void fireEvent(tenantId, "ticket.created", { ticketId, subject: seed.subject, channelType: seed.channelType });
  if (seed.messageId) {
    void fireEvent(tenantId, "message.created", {
      messageId: seed.messageId, ticketId, subject: seed.subject, body: seed.body, authorType: "customer",
    });
  }
}

/** A widget ban can hold the visitor's e-mail from before they had a user id, so both are lifted. */
async function senderHandles(
  tenantId: string,
  out: { channelType: string; contactId: string | null; senderHandle: string | null },
): Promise<string[]> {
  if (out.channelType !== "widget" || !out.contactId) return out.senderHandle ? [out.senderHandle] : [];
  const r = await withTenant(tenantId, (c) =>
    c.query("SELECT NULLIF(external_id, '') AS id, NULLIF(email, '') AS email FROM contacts WHERE id = $1", [out.contactId]),
  );
  return [r.rows[0]?.id, r.rows[0]?.email].filter((h): h is string => !!h);
}

/** The full reverse: un-hide the ticket, restore its lead, and remove the sender block. */
export async function unmarkConversationSpam(tenantId: string, ticketId: string): Promise<{ ticketId: string } | null> {
  const out = await setTicketSpam(tenantId, ticketId, false);
  if (!out) return null;
  // The spam check hid the ticket before the ticket.created automations, mirroring and webhooks saw it.
  if (out.wasAi) await announceRestoredTicket(tenantId, ticketId).catch(() => {});
  if (out.contactId) await setContactSpam(tenantId, out.contactId, false).catch(() => {});
  for (const handle of await senderHandles(tenantId, out)) await unblockByHandle(tenantId, out.channelType, handle).catch(() => {});

  // Reopen the ops-mirror post on restore (best-effort, fire-and-forget) — the inverse of the spam hook.
  void import("./discord-mirror.js")
    .then((m) => m.onConversationUnspam(tenantId, ticketId))
    .catch(() => {});

  return { ticketId: out.ticketId };
}

/**
 * Blocks an email sender or widget user once the workspace's threshold of their conversations is spam. Outreach doesn't count.
 * Returns the blocked handle, or null when the sender stays unblocked.
 */
export async function blockRepeatSender(tenantId: string, channelType: string, handle: string): Promise<string | null> {
  if (channelType !== "email" && channelType !== "widget") return null;
  const { blockAfter } = await getSpamSettings(tenantId);
  if (blockAfter <= 0) return null;
  const spam = await withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT count(*)::int AS n FROM tickets t
         JOIN contacts c ON c.tenant_id = t.tenant_id AND c.id = t.contact_id
        WHERE t.spam_at IS NOT NULL AND COALESCE(t.spam_kind, 'spam') = 'spam'
          AND lower(CASE WHEN $1 = 'email' THEN c.email ELSE COALESCE(NULLIF(c.external_id, ''), NULLIF(c.email, '')) END) = lower($2)`,
      [channelType, handle],
    );
    return r.rows[0].n as number;
  });
  if (spam < blockAfter) return null;
  const row = await blockSender(tenantId, { channelType, scope: "address", handle, reason: `${spam} spam conversations`, createdBy: null });
  return row?.handle ?? null;
}
