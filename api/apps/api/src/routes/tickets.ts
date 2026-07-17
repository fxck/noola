import type { FastifyInstance } from "fastify";
import { withTenant } from "@repo/db";
import { MergeTicketInput, SnoozeTicketInput, LinkTicketInput, AssignInput, TicketTeamInput, ReplyInput } from "@repo/contracts";
import { tenanted } from "../http/tenant.js";
import { getSlaPolicy, computeSla, type TicketSla } from "../sla.js";
import {
  listTickets, queryTickets, getTicketDetail, getReplyChannels, patchTicket, listUsers, assignTicket, setTicketTeam, setTicketStatus,
  snoozeTicket, mergeTicket, TICKET_PRIORITIES,
  type View, type TicketQuery, type TicketPriority, type TicketRow,
} from "../tickets.js";
import { markTicketRead, unreadTicketIds } from "../reads.js";
import { listLinks, linkTickets, unlinkTickets } from "../links.js";
import { summarizeTicket } from "../summarize.js";
import { draftArticleFromTicket } from "../article.js";
import { indexResolvedThread, unindexThread } from "../threads.js";
import { recordAudit } from "../audit.js";
import { emitDomainEvent } from "../automations.js";
import { ingestInbound } from "../ingest.js";
import { suggestReply } from "../copilot.js";
import { getChannelDriver } from "../channels/registry.js";
import { translateOutboundReply, stampOutboundTranslation } from "../translate.js";
import { claimAttachments, attachmentsForTicket } from "../attachments.js";
import { getTicketMirror, pushTicketToDiscord, mirrorUrl, syncMirrorState, mirrorEligibility } from "../discord-mirror.js";
import { getObject } from "../storage.js";
import type { MailAttachment } from "../email.js";

// Attach computed SLA state to ticket rows (policy loaded once; null when disabled).
async function withSla<T extends TicketRow>(tenantId: string, rows: T[]): Promise<(T & { sla: TicketSla | null })[]> {
  const policy = await getSlaPolicy(tenantId);
  return rows.map((r) => ({ ...r, sla: computeSla(policy, r) }));
}

// The core inbox/ticket surfaces: the list (Views + deep-table), per-agent unread, snooze, merge,
// related links, thread summarize / draft-article, detail, patch (priority/tags/type), the agent
// picker, assign, close/reopen (with survey + knowledge-index side effects), and the message thread.
export default async function ticketRoutes(app: FastifyInstance): Promise<void> {
  // Inbox listing with Views (?view=my|unassigned|needs_reply|closed|all, default open) OR the deep
  // ticketing table (?status/priority/tag/channel/q/sort/limit/offset → { tickets, total, ... }).
  app.get("/tickets", tenanted(async (tenantId, req) => {
    const q = (req.query as Record<string, string | undefined>) ?? {};
    const richKeys = ["table", "status", "priority", "tag", "channel", "teamId", "q", "sort", "sortDir", "limit", "offset"];
    const isTable = richKeys.some((k) => q[k] !== undefined);
    if (!isTable) {
      return { tickets: await withSla(tenantId, await listTickets(tenantId, (q.view as View) ?? "all", q.assigneeId)) };
    }
    const num = (v: string | undefined) => (v !== undefined && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : undefined);
    const query: TicketQuery = {
      status: q.status === "open" || q.status === "closed" ? q.status : "all",
      priority: q.priority ? q.priority.split(",").filter(Boolean) : undefined,
      tags: q.tag ? q.tag.split(",").filter(Boolean) : undefined,
      assigneeId: q.assigneeId || undefined,
      teamId: q.teamId || undefined,
      channelType: q.channel || undefined,
      q: q.q || undefined,
      sortBy: q.sort === "created_at" || q.sort === "priority" || q.sort === "sla" ? q.sort : "updated_at",
      sortDir: q.sortDir === "asc" ? "asc" : "desc",
      limit: num(q.limit) ?? 25,
      offset: num(q.offset) ?? 0,
    };
    const { rows, total } = await queryTickets(tenantId, query);
    return { tickets: await withSla(tenantId, rows), total, limit: query.limit, offset: query.offset };
  }));

  // Per-agent unread state. Static /tickets/unread is matched before the parametric /tickets/:id.
  app.get("/tickets/unread", tenanted(async (tenantId, req, reply) => {
    const userId = req.session?.userId;
    if (!userId) return reply.code(400).send({ error: "missing tenant" });
    return { ids: await unreadTicketIds(tenantId, userId) };
  }));

  app.post("/tickets/:id/read", tenanted(async (tenantId, req, reply) => {
    const userId = req.session?.userId;
    if (!userId) return reply.code(400).send({ error: "missing tenant" });
    await markTicketRead(tenantId, (req.params as { id: string }).id, userId);
    return { ok: true };
  }));

  // Snooze until a time (ISO), or unsnooze with null. Snoozed tickets leave the open queues.
  app.post("/tickets/:id/snooze", tenanted(async (tenantId, req, reply) => {
    const parsed = SnoozeTicketInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const ticket = await snoozeTicket(tenantId, (req.params as { id: string }).id, parsed.data.until);
    if (!ticket) return reply.code(404).send({ error: "ticket_not_found" });
    return { ticket };
  }));

  // Merge this (duplicate) ticket into another (canonical): move messages, close + flag it. Audited.
  app.post("/tickets/:id/merge", tenanted(async (tenantId, req, reply) => {
    const parsed = MergeTicketInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const res = await mergeTicket(tenantId, (req.params as { id: string }).id, parsed.data.into);
    if (!res.ok) {
      const code = res.reason.endsWith("not_found") ? 404 : 409;
      return reply.code(code).send({ error: res.reason });
    }
    void recordAudit(tenantId, {
      actorId: req.session?.userId ?? null,
      actorName: req.session?.name ?? null,
      action: "ticket.merged",
      entityType: "ticket",
      entityId: (req.params as { id: string }).id,
      meta: { into: parsed.data.into, movedMessages: res.movedMessages },
    });
    return { ok: true, target: res.target, movedMessages: res.movedMessages };
  }));

  // Related tickets (non-destructive symmetric links). List = viewer+; link/unlink = agent+.
  app.get("/tickets/:id/links", tenanted(async (tenantId, req) => ({
    links: await listLinks(tenantId, (req.params as { id: string }).id),
  })));

  app.post("/tickets/:id/links", tenanted(async (tenantId, req, reply) => {
    const parsed = LinkTicketInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const res = await linkTickets(tenantId, (req.params as { id: string }).id, parsed.data.linkedId, parsed.data.relation);
    if (!res.ok) return reply.code(res.reason === "same_ticket" ? 409 : 404).send({ error: res.reason });
    return { ok: true, created: res.created };
  }));

  app.delete("/tickets/:id/links/:linkedId", tenanted(async (tenantId, req, reply) => {
    const p = req.params as { id: string; linkedId: string };
    const ok = await unlinkTickets(tenantId, p.id, p.linkedId);
    if (!ok) return reply.code(404).send({ error: "link_not_found" });
    return { ok: true };
  }));

  // Auto-summarize a ticket's thread (handoff / triage). May invoke the tenant's paid model;
  // degrades to an extractive summary on the rule baseline.
  app.post("/tickets/:id/summarize", tenanted(async (tenantId, req, reply) => {
    const out = await summarizeTicket(tenantId, (req.params as { id: string }).id);
    if (!out) return reply.code(404).send({ error: "ticket_not_found" });
    return out;
  }));

  // Draft a KB article from a resolved ticket's thread. Returns an unsaved {title, body} draft.
  app.post("/tickets/:id/draft-article", tenanted(async (tenantId, req, reply) => {
    const out = await draftArticleFromTicket(tenantId, (req.params as { id: string }).id);
    if (!out) return reply.code(404).send({ error: "ticket_not_found" });
    return out;
  }));

  // A single ticket's row (routed /tickets/$id detail page).
  app.get("/tickets/:id", tenanted(async (tenantId, req, reply) => {
    const ticket = await getTicketDetail(tenantId, (req.params as { id: string }).id);
    if (!ticket) return reply.code(404).send({ error: "ticket_not_found" });
    return { ticket: (await withSla(tenantId, [ticket]))[0] };
  }));

  // Patch a ticket's priority / tags / type (deep ticketing). Emits a domain event per changed facet.
  app.patch("/tickets/:id", tenanted(async (tenantId, req, reply) => {
    const body = (req.body ?? {}) as { priority?: string; tags?: unknown; typeId?: unknown };
    const patch: { priority?: TicketPriority; tags?: string[]; typeId?: string | null } = {};
    if (body.priority !== undefined) {
      if (!(TICKET_PRIORITIES as readonly string[]).includes(body.priority)) {
        return reply.code(400).send({ error: "invalid priority" });
      }
      patch.priority = body.priority as TicketPriority;
    }
    if (body.typeId !== undefined) {
      if (body.typeId !== null && typeof body.typeId !== "string") {
        return reply.code(400).send({ error: "typeId must be a string or null" });
      }
      patch.typeId = (body.typeId as string | null) ?? null;
    }
    if (body.tags !== undefined) {
      if (!Array.isArray(body.tags) || body.tags.some((t) => typeof t !== "string")) {
        return reply.code(400).send({ error: "tags must be a string array" });
      }
      patch.tags = [...new Set((body.tags as string[]).map((t) => t.trim()).filter(Boolean).map((t) => t.slice(0, 40)))].slice(0, 20);
    }
    try {
      const ticket = await patchTicket(tenantId, (req.params as { id: string }).id, patch);
      if (!ticket) return reply.code(404).send({ error: "ticket_not_found" });
      const tid = ticket.id;
      if (patch.priority !== undefined) emitDomainEvent(tenantId, "ticket.priority_changed", { ticketId: tid, priority: ticket.priority });
      if (patch.tags !== undefined) emitDomainEvent(tenantId, "ticket.tagged", { ticketId: tid, tags: ticket.tags });
      if (patch.typeId !== undefined) emitDomainEvent(tenantId, "ticket.type_changed", { ticketId: tid, typeId: ticket.type_id });
      return { ticket };
    } catch (err) {
      if ((err as { code?: string }).code === "23503") return reply.code(400).send({ error: "invalid type" });
      throw err;
    }
  }));

  // Tenant agents (assignee picker).
  app.get("/users", tenanted(async (tenantId) => ({ users: await listUsers(tenantId) })));

  // Assign / unassign a ticket. The composite FK guarantees the assignee is in this tenant.
  app.post("/tickets/:id/assign", tenanted(async (tenantId, req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = AssignInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const out = await assignTicket(tenantId, id, parsed.data.assigneeId);
      if (!out) return reply.code(404).send({ error: "ticket_not_found" });
      emitDomainEvent(tenantId, "ticket.assigned", { ticketId: id, assigneeId: parsed.data.assigneeId });
      return out;
    } catch (e) {
      if ((e as { code?: string }).code === "23503") {
        return reply.code(400).send({ error: "invalid assignee (must be a user in this tenant)" });
      }
      throw e;
    }
  }));

  // Move a ticket into a team lane (teamId=null clears it). autoAssign also round-robins an
  // assignee from the team's members in the same transaction.
  app.post("/tickets/:id/team", tenanted(async (tenantId, req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = TicketTeamInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const out = await setTicketTeam(tenantId, id, parsed.data.teamId, parsed.data.autoAssign ?? false);
      if (!out) return reply.code(404).send({ error: "ticket_not_found" });
      if (out.assigneeId && parsed.data.autoAssign) {
        emitDomainEvent(tenantId, "ticket.assigned", { ticketId: id, assigneeId: out.assigneeId });
      }
      return out;
    } catch (e) {
      if ((e as { code?: string }).code === "23503") {
        return reply.code(400).send({ error: "invalid team (must be a team in this tenant)" });
      }
      throw e;
    }
  }));

  // Close / reopen — the lifecycle behind the Views. Close indexes the resolved thread as a
  // knowledge source + fires ticket.closed (the survey seed automation delivers CSAT/NPS on match).
  app.post("/tickets/:id/close", tenanted(async (tenantId, req, reply) => {
    const { id } = req.params as { id: string };
    const out = await setTicketStatus(tenantId, id, "closed");
    if (!out) return reply.code(404).send({ error: "ticket_not_found" });
    void indexResolvedThread(tenantId, id).catch((err) => app.log.warn({ err, ticketId: id }, "index resolved thread failed"));
    emitDomainEvent(tenantId, "ticket.closed", { ticketId: id });
    return out;
  }));

  app.post("/tickets/:id/reopen", tenanted(async (tenantId, req, reply) => {
    const { id } = req.params as { id: string };
    const out = await setTicketStatus(tenantId, id, "open");
    if (!out) return reply.code(404).send({ error: "ticket_not_found" });
    void unindexThread(id).catch((err) => app.log.warn({ err, ticketId: id }, "unindex thread failed"));
    // No ticket.reopened trigger exists, so the ops-mirror unarchive is called directly here.
    void syncMirrorState(tenantId, id).catch(() => {});
    return out;
  }));

  // Discord ops-mirror state for the context rail: mirrored → deep link; not mirrored → whether
  // it WILL auto-mirror (so the UI doesn't offer a pointless manual push when auto covers it).
  app.get("/tickets/:id/mirror", tenanted(async (tenantId, req) => {
    const id = (req.params as { id: string }).id;
    const mirror = await getTicketMirror(tenantId, id);
    if (mirror) return { mirrored: true, url: mirrorUrl(mirror), hasBinding: true, discordOrigin: false, auto: false };
    const eligibility = await mirrorEligibility(tenantId, id);
    return { mirrored: false, url: null, ...eligibility };
  }));

  // Manual "Push to Discord" — mirror this ticket regardless of the binding filter.
  app.post("/tickets/:id/mirror", tenanted(async (tenantId, req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { bindingId?: string };
    const res = await pushTicketToDiscord(tenantId, id, body.bindingId ?? null);
    if (!res.mirror) return reply.code(409).send({ error: res.reason ?? "mirror_failed" });
    return { mirrored: true, url: mirrorUrl(res.mirror) };
  }));

  app.get("/tickets/:id/messages", tenanted(async (tenantId, req) => {
    const { id } = req.params as { id: string };
    const [messages, byMsg, replyChannels] = await Promise.all([
      withTenant(tenantId, async (c) => {
        const r = await c.query(
          `SELECT m.id, m.ticket_id, m.author_type, m.author_kind, m.body, COALESCE(m.auto, false) AS auto,
                  m.meta, m.channel_type, m.created_at,
                  COALESCE((SELECT u.name FROM users u WHERE u.tenant_id = m.tenant_id AND u.id = m.author_id),
                           m.author_external_name) AS author_name,
                  COALESCE((SELECT u.avatar_url FROM users u WHERE u.tenant_id = m.tenant_id AND u.id = m.author_id),
                           m.author_external_avatar_url) AS author_avatar_url
             FROM messages m WHERE m.ticket_id = $1 AND m.deleted_at IS NULL ORDER BY m.created_at ASC`,
          [id],
        );
        return r.rows as Array<{ id: string }>;
      }),
      attachmentsForTicket(tenantId, id),
      getReplyChannels(tenantId, id),
    ]);
    // Hydrate each message with its claimed attachments (thread render + download links). `channels`
    // powers the composer's channel picker (the contact's reachable channels; `current` = default).
    // `emailCc` = the other recipients on the customer's latest email — the reply-all default.
    const lastEmailMeta = [...messages].reverse()
      .find((m) => (m as { author_type?: string; channel_type?: string }).author_type === "customer"
        && (m as { channel_type?: string }).channel_type === "email") as { meta?: { cc?: string[] } } | undefined;
    return {
      messages: messages.map((m) => ({ ...m, attachments: byMsg.get(m.id) ?? [] })),
      channels: replyChannels,
      emailCc: Array.isArray(lastEmailMeta?.meta?.cc) ? lastEmailMeta.meta.cc : [],
    };
  }));

  // Agent reply to a ticket — persists the message, emits the outbox event (so the inbox updates
  // live for every agent), and posts back to the ticket's origin channel when it's external.
  app.post("/tickets/:id/reply", tenanted(async (tenantId, req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = ReplyInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const result = await ingestInbound({
      tenantId,
      body: parsed.data.body,
      authorType: "agent",
      ticketId: id,
      authorId: req.session?.userId ?? null,
      channelOverride: parsed.data.channel ?? null,
    });

    // Claim any pre-uploaded attachments onto this agent message (best-effort, post-commit). Returns
    // the claimed files' storage info so an email reply can carry them as real attachments.
    const claimed = await claimAttachments(tenantId, result.ticketId, result.messageId, parsed.data.attachmentIds ?? [])
      .catch((err) => { app.log.warn({ err, ticketId: id }, "attachment claim failed"); return []; });

    // Auto-translation (Wave 4): when the ticket is in another language and auto-translate is on, the
    // customer receives the reply in THEIR language while the stored message keeps the agent's words.
    // `dispatchBody` is what the channel sends; `meta` (when set) is stamped on the agent message so
    // the thread shows a "sent in X" note. A no-op (dispatchBody === body, meta null) otherwise.
    const { dispatchBody, meta } = await translateOutboundReply(tenantId, result.ticketId, parsed.data.body);
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
          { tenantId, channelType: result.channelType, externalChannelId: result.externalChannelId, subject: result.subject, ticketId: result.ticketId },
          dispatchBody,
          // agentName signs the email render ("— Ales"); attachments only when claimed.
          {
            ...(mailAttachments?.length ? { attachments: mailAttachments } : {}),
            ...(parsed.data.cc?.length && result.channelType === "email" ? { cc: parsed.data.cc } : {}),
            agentName: req.session?.name ?? null,
          },
        )
      : { delivered: false as boolean, reason: "no-driver" };
    if (driver?.dispatch && !out.delivered) {
      app.log.warn({ ticketId: id, channel: result.channelType, reason: out.reason }, "outbound not delivered");
    }

    return reply.code(201).send({
      ticketId: result.ticketId,
      messageId: result.messageId,
      delivered: out.delivered,
    });
  }));

  // Copilot: a retrieval-augmented suggested reply for a ticket. Retrieves the tenant's KB +
  // document passages relevant to the latest customer message and drafts a grounded, cited reply
  // (through the model seam). The agent reviews and sends — this endpoint never sends anything.
  app.post("/tickets/:id/suggest", tenanted(async (tenantId, req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await suggestReply(tenantId, id);
    } catch (err) {
      app.log.error({ err, ticketId: id }, "suggest failed");
      return reply.code(502).send({ error: "suggestion unavailable" });
    }
  }));
}
