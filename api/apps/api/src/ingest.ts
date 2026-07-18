import { withTenant } from "@repo/db";
import { EVENT_TYPES } from "@repo/contracts";
import { modelDriver } from "./model.js";
import { resolveContactForInbound } from "./contacts.js";

export interface IngestInput {
  tenantId: string;
  body: string;
  authorType: "customer" | "agent";
  idempotencyKey?: string | null;
  ticketId?: string | null;
  subject?: string | null;
  /** Origin channel type of THIS message (default 'synthetic'). Stamped on the message; on a customer
   *  inbound it also becomes the conversation's current reply channel. */
  channelType?: string;
  /** Where an outbound reply on this channel goes (email address, discord channel id, phone, widget
   *  conversation id…). Stamped on the message + on the ticket as the current reply target. NOT the
   *  threading key anymore — threading is by contact (omnichannel). */
  externalChannelId?: string | null;
  /** Who sent this inbound — resolves/creates the CONTACT the conversation threads onto. `externalId`
   *  is the sender's stable per-channel handle (defaults to externalChannelId when the sender handle
   *  IS the reply target, e.g. email/whatsapp/telegram/widget); email is the cross-channel unifier. */
  identity?: { externalId?: string | null; email?: string | null; name?: string | null };
  /** Agent reply only: send on THIS channel instead of the ticket's current reply channel. The
   *  message is stamped with it and the outbound target is resolved from the contact's identity for
   *  that channel (so a reply can go out on any channel the contact is reachable on). Ignored for
   *  customer inbound (their channel is where the message actually arrived). */
  channelOverride?: string | null;
  /** Set to 'automation' when the automations engine itself is posting (a `reply` action) —
   *  suppresses re-firing the automation triggers below, so a rule can't cascade off its own
   *  reply. 'discord_mirror' marks a mirror-promoted reply so the ops-mirror relay hook doesn't
   *  echo it back into the forum post it came from. */
  origin?: "automation" | "discord_mirror";
  /** The agent USER who authored this message (authorType 'agent' only) — stamped on the
   *  message so the thread can show real names. Absent for customer/auto messages. */
  authorId?: string | null;
  /** How this inbound threads (§5.7). 'contact' (default) = one open conversation per contact across
   *  channels (email/widget/Slack/…). 'thread' = one ticket per external THREAD id (Discord): the
   *  conversational unit is the thread, not the contact, so N people in one thread → one ticket and
   *  one person across N threads → N tickets. Only the Discord adapter sets 'thread'. */
  threadingPolicy?: "contact" | "thread";
  /** Discord thread key (thread policy only). The stable ticket key + reply target for a thread. */
  externalThreadId?: string | null;
  externalParentId?: string | null;                    // forum/text channel id
  externalThreadKind?: string | null;                  // 'text_thread'|'forum_post'|'channel'
  externalGuildId?: string | null;
  /** Operating mode frozen onto the ticket at create (§5.1). Default 'staffed'. */
  supportMode?: "staffed" | "community";
  /** Per-message author classification (kills the email-shaped single-identity model). */
  authorKind?: "customer" | "agent" | "ai" | "community" | null;
  authorExternalName?: string | null;
  authorExternalAvatarUrl?: string | null;
  /** §5.3 — suppress the post-commit ambient autoreply dispatch (used by /ask + thread pre-seat so
   *  ingesting a question doesn't also fire ambient autoreply on the same turn). */
  skipAutoreply?: boolean;
}

export interface IngestResult {
  replay: boolean;
  ticketId: string;
  messageId: string;
  subject: string;
  tenantId: string;
  body: string;
  channelType: string;
  externalChannelId: string | null;
  /** The contact this conversation belongs to (null only on the legacy idempotency-replay path). */
  contactId: string | null;
  /** True when THIS ingest created a brand-new ticket (drives the ticket.created webhook). */
  ticketCreated: boolean;
}

/**
 * The shared inbound core. One tenant-scoped transaction that resolves or creates
 * the ticket, inserts the message (idempotent), and writes the transactional
 * outbox event. Every channel — synthetic, Discord, email (and a future lightweight Slack) — funnels
 * through here, so tenant isolation, idempotency, and the outbox are enforced in
 * exactly one place. Ticket resolution: explicit id → existing external channel →
 * a brand-new ticket.
 */
export async function ingestInbound(input: IngestInput): Promise<IngestResult> {
  const channelType = input.channelType ?? "synthetic";

  // Classify whose-turn BEFORE opening the transaction: the ModelServingDriver may
  // do I/O (a hosted/ONNX model), and a network call must not hold a DB txn open.
  const whoseTurn = await modelDriver.classifyWhoseTurn({
    authorType: input.authorType,
    body: input.body,
    subject: input.subject,
  });

  const result = await withTenant(input.tenantId, async (c) => {
    // idempotency short-circuit (replayed inbound message)
    if (input.idempotencyKey) {
      const ex = await c.query(
        `SELECT m.id, m.ticket_id, t.subject, t.channel_type, t.external_channel_id, t.contact_id
           FROM messages m
           JOIN tickets t ON t.id = m.ticket_id AND t.tenant_id = m.tenant_id
          WHERE m.idempotency_key = $1 LIMIT 1`,
        [input.idempotencyKey],
      );
      if (ex.rowCount) {
        const r = ex.rows[0];
        return {
          replay: true, ticketId: r.ticket_id, messageId: r.id, subject: r.subject,
          tenantId: input.tenantId, body: input.body,
          channelType: r.channel_type, externalChannelId: r.external_channel_id,
          contactId: r.contact_id ?? null,
          ticketCreated: false,
        };
      }
    }

    // Resolve the conversation (omnichannel threading).
    //  - Agent reply / explicit ticketId: append to that ticket; the message inherits the ticket's
    //    CURRENT reply channel (where the reply goes = the last inbound customer channel).
    //  - Customer inbound: resolve the CONTACT from the sender identity, then thread onto that
    //    contact's OPEN conversation across ANY channel (else open a new one). The message carries
    //    THIS inbound's channel, and the ticket's reply channel is retargeted to it.
    let ticketId = input.ticketId ?? null;
    let subject = input.subject ?? input.body.slice(0, 80);
    // The channel stamped on THIS message + used for outbound routing.
    let msgChannelType = channelType;
    let msgExternal = input.externalChannelId ?? null;
    let contactId: string | null = null;
    let ticketCreated = false;
    const isCustomer = input.authorType === "customer";

    if (ticketId) {
      const t = await c.query(
        "SELECT subject, channel_type, external_channel_id, contact_id FROM tickets WHERE id = $1",
        [ticketId],
      );
      if (!t.rowCount) {
        const err: Error & { statusCode?: number } = new Error("ticket_not_found");
        err.statusCode = 404;
        throw err;
      }
      subject = t.rows[0].subject;
      contactId = t.rows[0].contact_id ?? null;
      if (input.authorType === "agent") {
        const ticketChannel = t.rows[0].channel_type as string;
        const override = input.channelOverride?.trim() || null;
        if (override && override !== ticketChannel) {
          // The agent chose a different channel: stamp it, and resolve THAT channel's outbound
          // handle from the contact's identities (the reply routes to where the contact is
          // reachable on that channel). No identity → no external target (message still labelled).
          msgChannelType = override;
          if (contactId) {
            const idr = await c.query(
              `SELECT external_id FROM contact_identities
                 WHERE contact_id = $1 AND channel_type = $2
                 ORDER BY created_at DESC LIMIT 1`,
              [contactId, override],
            );
            msgExternal = idr.rowCount ? (idr.rows[0].external_id as string) : null;
          } else {
            msgExternal = null;
          }
        } else {
          // Default: a reply goes out on the ticket's current channel (the last inbound customer channel).
          msgChannelType = ticketChannel;
          msgExternal = t.rows[0].external_channel_id;
        }
      }
    } else if ((input.threadingPolicy ?? "contact") === "thread") {
      // Discord thread policy (§5.7): thread = ticket, keyed on external_thread_id — NOT the contact.
      // Resolve the contact for ATTRIBUTION ONLY (per-message author + CRM), never for threading, so a
      // contact using widget AND Discord is not collapsed into one conversation.
      // Phase 2 guard (refuted-claim #2): ONLY a seeker (authorType 'customer') resolves/creates a
      // contact. A teammate or community responder (authorType 'agent') must NEVER mint a phantom
      // contact — they are message-level identities (messages.author_external_*); their inbound just
      // resolves the thread's ticket (a mod-first thread opens a customer-less ticket, contact_id null).
      if (isCustomer) {
        contactId = await resolveContactForInbound(c, {
          channelType,
          externalId: input.identity?.externalId ?? input.externalChannelId ?? null,
          email: input.identity?.email ?? null,
          name: input.identity?.name ?? null,
        });
      }
      // Atomic upsert keyed on the thread. Reopens a closed/solved thread (a new message reopens).
      // The partial-index predicate MUST be repeated in ON CONFLICT or inference fails.
      const up = await c.query(
        `INSERT INTO tickets (tenant_id, subject, channel_type, external_channel_id, contact_id,
             external_thread_id, external_parent_id, external_thread_kind, external_guild_id, support_mode)
         VALUES (current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (tenant_id, channel_type, external_thread_id) WHERE external_thread_id IS NOT NULL
         DO UPDATE SET status = CASE WHEN tickets.status IN ('closed','solved') THEN 'open' ELSE tickets.status END,
                       whose_turn = 'us', updated_at = now()
         RETURNING id, subject, (xmax = 0) AS created`,
        [subject, channelType, input.externalChannelId ?? null, contactId,
         input.externalThreadId ?? null, input.externalParentId ?? null,
         input.externalThreadKind ?? null, input.externalGuildId ?? null,
         input.supportMode ?? "staffed"],
      );
      ticketId = up.rows[0].id;
      subject = up.rows[0].subject;
      ticketCreated = up.rows[0].created === true;
    } else {
      // Customer inbound with no explicit ticket → resolve the contact + thread onto their open convo.
      contactId = await resolveContactForInbound(c, {
        channelType,
        externalId: input.identity?.externalId ?? input.externalChannelId ?? null,
        email: input.identity?.email ?? null,
        name: input.identity?.name ?? null,
      });
      // §5.7 carve-out: a Discord thread-ticket (external_thread_id set) is never swept into a
      // contact-unified email/widget conversation, and vice-versa.
      const open = await c.query(
        "SELECT id, subject FROM tickets WHERE contact_id = $1 AND status = 'open' AND external_thread_id IS NULL ORDER BY updated_at DESC LIMIT 1",
        [contactId],
      );
      if (open.rowCount) {
        ticketId = open.rows[0].id;
        subject = open.rows[0].subject;
      } else {
        const ins = await c.query(
          "INSERT INTO tickets (tenant_id, subject, channel_type, external_channel_id, contact_id) VALUES (current_tenant(), $1, $2, $3, $4) RETURNING id",
          [subject, channelType, input.externalChannelId ?? null, contactId],
        );
        ticketId = ins.rows[0].id;
        ticketCreated = true;
      }
    }

    // every resolution branch above assigns a ticket id; assert the invariant so
    // the type narrows to string (and as a runtime backstop it can never be null).
    if (!ticketId) throw new Error("ingest: ticket resolution produced no id");

    // insert the message; the partial unique index backstops the idempotency race
    let messageId: string;
    try {
      const m = await c.query(
        `INSERT INTO messages (tenant_id, ticket_id, author_type, body, idempotency_key, channel_type,
             external_channel_id, author_id, author_kind, author_contact_id, author_external_name, author_external_avatar_url)
         VALUES (current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [ticketId, input.authorType, input.body, input.idempotencyKey ?? null, msgChannelType, msgExternal,
         input.authorId ?? null,
         input.authorKind ?? (isCustomer ? "customer" : "agent"),
         isCustomer ? contactId : null,
         input.authorExternalName ?? null,
         input.authorExternalAvatarUrl ?? null],
      );
      messageId = m.rows[0].id;
    } catch (e) {
      if ((e as { code?: string }).code === "23505" && input.idempotencyKey) {
        const ex = await c.query(
          `SELECT m.id, m.ticket_id, t.subject, t.channel_type, t.external_channel_id, t.contact_id
             FROM messages m
             JOIN tickets t ON t.id = m.ticket_id AND t.tenant_id = m.tenant_id
            WHERE m.idempotency_key = $1 LIMIT 1`,
          [input.idempotencyKey],
        );
        const r = ex.rows[0];
        return {
          replay: true, ticketId: r.ticket_id, messageId: r.id, subject: r.subject,
          tenantId: input.tenantId, body: input.body,
          channelType: r.channel_type, externalChannelId: r.external_channel_id,
          contactId: r.contact_id ?? null,
          ticketCreated: false,
        };
      }
      throw e;
    }

    // whose-turn automation via the ModelServingDriver (classified above, pre-txn).
    // Baseline: customer→'us', agent→'customer'; the driver refines on content
    // (a customer "thanks!" → 'customer'; an agent "I'll look into it" → 'us').
    //
    // Channel retarget: a CUSTOMER inbound also retargets the conversation's reply channel to the
    // channel THIS message arrived on — so an agent reply routes back to where the customer last
    // wrote (the omnichannel "reply to last inbound channel" rule). Agent replies leave it alone.
    // Threading only ever lands on an OPEN ticket (else a new one is created), so no reopen is
    // needed — a customer writing after their prior conversation closed opens a fresh one.
    // whose_turn + updated_at always write (a Discord customer reply must still enter needs-reply and
    // stay autoreply-eligible). Only the reply-target RETARGET is gated OFF for thread policy — a
    // thread's reply target is the stable thread id, so there is nothing to hop (§5.7, step I.4).
    const isCustomerUpd = input.authorType === "customer";
    const retarget = isCustomerUpd && (input.threadingPolicy ?? "contact") !== "thread";
    await c.query(
      `UPDATE tickets
          SET updated_at = now(),
              whose_turn = $2,
              channel_type        = CASE WHEN $3::boolean THEN $4 ELSE channel_type END,
              external_channel_id = CASE WHEN $3::boolean THEN $5 ELSE external_channel_id END
        WHERE id = $1`,
      [ticketId, whoseTurn, retarget, msgChannelType, msgExternal],
    );

    // "Last contacted" (Intercom-parity): an outbound (non-customer) message stamps the ticket's
    // contact — the last time WE reached out. Written under Intercom's display key; no-op when the
    // ticket has no contact (e.g. a channel-post with no resolved person).
    if (input.authorType !== "customer") {
      await c.query(
        `UPDATE contacts
            SET attributes = COALESCE(attributes, '{}'::jsonb) || jsonb_build_object('Last contacted', now()::text)
           FROM tickets t
          WHERE t.id = $1 AND contacts.id = t.contact_id`,
        [ticketId],
      );
    }

    // transactional outbox — same txn as the write; the relay publishes later.
    const envelope = {
      id: messageId,
      type: EVENT_TYPES.messageCreated,
      tenantId: input.tenantId,
      ticketId,
      occurredAt: new Date().toISOString(),
      data: {
        messageId,
        ticketId,
        subject,
        body: input.body,
        authorType: input.authorType,
        // Carried so the edge can fan a widget-channel reply out to the customer's public
        // widget socket (widget:<externalChannelId>) — real-time messenger, no polling.
        // This is the MESSAGE's channel (agent reply → the ticket's current reply target).
        channelType: msgChannelType,
        externalChannelId: msgExternal,
      },
    };
    await c.query(
      "INSERT INTO outbox (tenant_id, event_type, subject, payload) VALUES (current_tenant(), $1, 'noola.events.' || current_tenant(), $2::jsonb)",
      [EVENT_TYPES.messageCreated, JSON.stringify(envelope)],
    );

    return {
      replay: false, ticketId, messageId, subject,
      tenantId: input.tenantId, body: input.body,
      channelType: msgChannelType, externalChannelId: msgExternal,
      contactId,
      ticketCreated,
    };
  });

  // Autoreply evaluation — post-commit, fire-and-forget, off unless the tenant opted
  // in. Only fresh inbound customer messages are candidates; agent messages (incl.
  // auto-sent replies) never re-trigger. The dynamic import breaks the ingest⇄autoreply
  // module cycle (autoreply sends BY calling ingestInbound). Failures are swallowed —
  // a drafting/gate error must never affect the inbound write that already committed.
  if (input.authorType === "customer" && !result.replay && !input.skipAutoreply) {
    void import("./autoreply.js")
      .then((m) => m.evaluateAutoreply(result.tenantId, result.ticketId, result.messageId))
      .catch(() => {});
  }

  // Outbound webhooks — post-commit, fire-and-forget, same style as autoreply. A fresh
  // inbound (never a replay) emits message.created, plus ticket.created when THIS ingest
  // opened a new ticket. Dynamic import keeps webhooks off the ingest hot path; failures
  // are swallowed so a delivery error never touches the write that already committed.
  if (!result.replay) {
    void import("./webhooks.js")
      .then((m) => {
        if (result.ticketCreated) {
          void m.fireEvent(result.tenantId, "ticket.created", {
            ticketId: result.ticketId,
            subject: result.subject,
            channelType: result.channelType,
          });
        }
        void m.fireEvent(result.tenantId, "message.created", {
          messageId: result.messageId,
          ticketId: result.ticketId,
          subject: result.subject,
          body: result.body,
          authorType: input.authorType,
        });
      })
      .catch(() => {});
  }

  // Routing & assignment now runs through the automations engine (dogfood L2): the
  // `ticket.created` event below is matched by the tenant's routing SEED automations (projected
  // from routing_rules), which first-match-assign via the strategy-aware `assign` action + `stop`.
  // The old bespoke applyRouting hook was retired — there is no separate routing dispatch here.

  // Automations (Agent Studio) — post-commit, fire-and-forget, same discipline as autoreply
  // and webhooks. A fresh inbound (never a replay) fires the trigger events the rules engine
  // matches on. origin:'automation' is skipped so an automation's OWN reply can't re-trigger
  // the engine (no cascade). ticket.created fires when this ingest opened a new ticket;
  // message.received fires for customer messages only (agent replies never re-trigger).
  if (!result.replay && input.origin !== "automation") {
    void import("./automations.js")
      .then((m) => {
        const seed = {
          ticketId: result.ticketId,
          messageId: result.messageId,
          subject: result.subject,
          body: result.body,
          channelType: result.channelType,
          authorType: input.authorType,
        };
        // Community-mode threads (§5.1) are observed, not staffed: their creation must NOT
        // fire routing/assignment or SLA-start automations (community tickets never enter the
        // agent queue). Suppress ticket.created for them; message.received still fires (the
        // reply action stands down for community via claimAnswerForAutomationReply).
        if (result.ticketCreated && input.supportMode !== "community")
          m.emitDomainEvent(result.tenantId, "ticket.created", seed);
        if (input.authorType === "customer") m.emitDomainEvent(result.tenantId, "message.received", seed);
      })
      .catch(() => {});
  }

  // Discord ops-mirror relay: a fresh customer message or agent reply on a mirrored ticket appends
  // into its forum post (two-way timeline mirror). Discord-origin tickets are skipped (the team is
  // already there), and origin 'discord_mirror' (a promoted reply) never echoes back into the post
  // it came from. Best-effort, off the ingest path — no-ops instantly when the ticket isn't mirrored.
  if (!result.replay && input.origin !== "discord_mirror" && result.channelType !== "discord") {
    void import("./discord-mirror.js")
      .then((m) => m.relayTicketMessage(result.tenantId, result.ticketId, result.messageId))
      .catch(() => {});
  }

  // Sentiment: classify each inbound customer message and stamp the ticket (best-effort, off the
  // ingest path). Replays are skipped — the row already carries its sentiment.
  if (!result.replay && input.authorType === "customer") {
    void import("./sentiment.js")
      .then((m) => m.updateTicketSentiment(result.tenantId, result.ticketId, result.body))
      .catch(() => {});
  }

  // Language: detect + stamp the ticket's locale from each inbound customer message (fill-once), and
  // — when auto-translate is on and the customer's language differs from the workspace's — translate
  // the message for the agent onto the message meta. Best-effort, off the ingest path; replays skip
  // (the row already carries its locale/translation).
  if (!result.replay && input.authorType === "customer") {
    void import("./translate.js")
      .then((m) => m.processInboundLanguage(result.tenantId, result.ticketId, result.messageId, result.body))
      .catch(() => {});
  }

  // Auto-tagging now runs through the automations engine: the `ticket.created` event emitted above
  // is matched by the tenant's managed 'autotag' seed automations (projected from tag_rules by
  // seedflows.projectAutotag) — deterministic keyword rules + an optional `ai_tag` model flow. The
  // old bespoke autoTagTicket ingest hook was retired (STUDIO-SEEDED-FLOWS.md #1).

  // Primary-topic assignment: same trigger as auto-tagging (new ticket, opening message defines the
  // topic), but a single label that powers the Topics explorer. Best-effort, off the ingest path.
  if (!result.replay && result.ticketCreated && input.origin !== "automation") {
    void import("./topics.js")
      .then((m) => m.assignTicketTopic(result.tenantId, result.ticketId, result.subject, result.body))
      .catch(() => {});
  }

  return result;
}
