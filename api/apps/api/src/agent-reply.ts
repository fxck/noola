import { withTenant } from "@repo/db";
import { ingestInbound } from "./ingest.js";
import { getChannelDriver } from "./channels/registry.js";
import { translateOutboundReply, stampOutboundTranslation } from "./translate.js";
import { claimAttachments } from "./attachments.js";
import { getObject } from "./storage.js";
import { notifyContactByEmailIfAway, type MailAttachment } from "./email.js";

export interface AgentReplyRequest {
  ticketId: string;
  body: string;
  attachmentIds?: string[];
  channel?: string | null;
  cc?: string[];
  idempotencyKey?: string | null;
  author: { userId: string | null; name: string | null; email: string | null };
}

export interface AgentReplyResult {
  ticketId: string;
  messageId: string;
  delivered: boolean;
  queued: boolean;
  replay: boolean;
}

interface Log {
  warn: (obj: unknown, msg?: string) => void;
}

/** Records an agent's reply on the ticket and sends it to the customer's channel. The reply route and the scheduled-reply worker share it. */
export async function sendAgentReply(tenantId: string, r: AgentReplyRequest, log: Log): Promise<AgentReplyResult> {
  const result = await ingestInbound({
    tenantId,
    body: r.body,
    authorType: "agent",
    ticketId: r.ticketId,
    authorId: r.author.userId,
    channelOverride: r.channel ?? null,
    // Idempotency: a client-supplied token collapses a double-submit / transport retry to one message.
    idempotencyKey: r.idempotencyKey ?? null,
  });

  // Replay: this exact send already landed on a prior request (double ⌘↵, retry). The message exists
  // and was fully handled the first time — return it WITHOUT muting the assistant, claiming
  // attachments, or dispatching to the channel again. Re-dispatching is the duplicate external send
  // this guard exists to prevent.
  if (result.replay) {
    return { ticketId: result.ticketId, messageId: result.messageId, delivered: true, queued: false, replay: true };
  }

  // A human agent stepped in — stand the assistant down on this ticket so ambient autoreply doesn't
  // talk over the human on the customer's next message (the human owns the thread until the AI is
  // re-enabled via the assistant-mode toggle). whose_turn is left alone — the reply already moved the
  // ball to the customer. Idempotent + cheap (a no-op once already muted).
  await withTenant(tenantId, async (c) => {
    await c.query("UPDATE tickets SET assistant_enabled = false WHERE id = $1 AND assistant_enabled", [result.ticketId]);
  }).catch(() => {});

  // Claim any pre-uploaded attachments onto this agent message (best-effort, post-commit). Returns
  // the claimed files' storage info so an email reply can carry them as real attachments.
  const claimed = await claimAttachments(tenantId, result.ticketId, result.messageId, r.attachmentIds ?? [])
    .catch((err) => { log.warn({ err, ticketId: r.ticketId }, "attachment claim failed"); return []; });

  // Auto-translation (Wave 4): when the ticket is in another language and auto-translate is on, the
  // customer receives the reply in THEIR language while the stored message keeps the agent's words.
  // `dispatchBody` is what the channel sends; `meta` (when set) is stamped on the agent message so
  // the thread shows a "sent in X" note. A no-op (dispatchBody === body, meta null) otherwise.
  const { dispatchBody, meta } = await translateOutboundReply(tenantId, result.ticketId, r.body);
  if (meta) void stampOutboundTranslation(tenantId, result.messageId, meta);

  // Dispatch the agent reply back to the ticket's origin channel through the channel registry —
  // one uniform seam for discord/email/slack/telegram/whatsapp. Channels with no outbound driver
  // (synthetic, widget — the widget replies over the realtime edge) simply have nothing to send.
  // For an email reply, fetch the claimed attachment bytes so nodemailer sends them inline with the
  // message. Other channels don't carry file attachments, so we only pay this for email.
  let mailAttachments: MailAttachment[] | undefined;
  if (claimed.length && result.channelType === "email") {
    const parts = await Promise.all(
      claimed.map(async (a) => {
        const obj = await getObject(a.storage_key);
        return obj ? ({ filename: a.filename, content: obj.body, contentType: a.content_type } as MailAttachment) : null;
      }),
    );
    mailAttachments = parts.filter((p): p is MailAttachment => p !== null);
  }

  const driver = getChannelDriver(result.channelType);
  const out = driver?.dispatch
    ? await driver.dispatch(
        { tenantId, channelType: result.channelType, externalChannelId: result.externalChannelId, subject: result.subject, ticketId: result.ticketId, messageId: result.messageId },
        dispatchBody,
        // agentName signs the email render ("— Ales"); attachments only when claimed.
        {
          ...(mailAttachments?.length ? { attachments: mailAttachments } : {}),
          ...(r.cc?.length && result.channelType === "email" ? { cc: r.cc } : {}),
          agentName: r.author.name,
          // Teammate sending: the agent's signup email becomes the From address when the workspace is
          // in teammate mode and that domain is verified (else it's just the display name on support@).
          agentEmail: r.author.email,
          // Read receipt: embed a tracking pixel keyed to THIS agent message so an email open stamps seen_at.
          seenMessageId: result.messageId,
        },
      )
    : { delivered: false as boolean, reason: "no-driver" };
  if (driver?.dispatch && !out.delivered) {
    log.warn({ ticketId: r.ticketId, channel: result.channelType, reason: out.reason }, "outbound not delivered");
  }

  // Email delivery tracking (0114): persist the provider Message-ID + an initial head so the thread
  // shows send confidence immediately — 'sent' (SMTP handed off) or 'failed' (driver couldn't send).
  // A provider delivery webhook later advances 'sent' → delivered / bounced / complained. Best-effort.
  if (result.channelType === "email" && driver?.dispatch) {
    await withTenant(tenantId, (c) =>
      c.query("UPDATE messages SET provider_message_id = $2, delivery_status = $3 WHERE id = $1", [
        result.messageId,
        out.providerMessageId ?? null,
        out.delivered ? "sent" : "failed",
      ]),
    ).catch((err) => log.warn({ err, ticketId: r.ticketId }, "delivery status stamp failed"));
  }

  // Widget/away fallback: a widget reply has no outbound driver (the widget polls). If the customer
  // isn't currently in the widget and we have their email, ALSO email the reply so an away customer
  // still hears back instead of it sitting unseen until they reopen the widget. Best-effort.
  if (!out.delivered && (result.channelType === "widget" || out.reason === "no-driver")) {
    void notifyContactByEmailIfAway(tenantId, {
      ticketId: result.ticketId,
      subject: result.subject,
      body: dispatchBody,
      agentName: r.author.name,
      // Read receipt: stamp seen_at on this reply if the away customer opens the fallback email.
      messageId: result.messageId,
    }).catch((err) => log.warn({ err, ticketId: r.ticketId }, "email fallback failed"));
  }

  return {
    ticketId: result.ticketId,
    messageId: result.messageId,
    delivered: out.delivered,
    queued: out.queued === true,
    replay: false,
  };
}
