import { setTicketSpam } from "./tickets.js";
import { setContactSpam, contactLiveTicketCount } from "./contacts.js";
import { blockSender, unblockByHandle, type BlockScope } from "./blocklist.js";

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
      channelType: out.channelType, scope: opts.blockScope ?? "address", handle: out.senderHandle,
      reason: "marked spam", createdBy: opts.actorId ?? null,
    }).catch(() => null);
    blocked = row?.handle ?? null;
  }

  // Drop the lead only when this spam ticket was the contact's ONLY conversation.
  let leadDropped = false;
  if (opts.dropLead && out.contactId && (await contactLiveTicketCount(tenantId, out.contactId)) === 0) {
    await setContactSpam(tenantId, out.contactId, true).catch(() => {});
    leadDropped = true;
  }
  return { ticketId: out.ticketId, blocked, leadDropped };
}

/** The full reverse: un-hide the ticket, restore its lead, and remove the sender block. */
export async function unmarkConversationSpam(tenantId: string, ticketId: string): Promise<{ ticketId: string } | null> {
  const out = await setTicketSpam(tenantId, ticketId, false);
  if (!out) return null;
  if (out.contactId) await setContactSpam(tenantId, out.contactId, false).catch(() => {});
  if (out.senderHandle) await unblockByHandle(tenantId, out.channelType, out.senderHandle).catch(() => {});
  return { ticketId: out.ticketId };
}
