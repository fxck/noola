import type { FastifyInstance } from "fastify";
import { ReplySettingsInput } from "@repo/contracts";
import { tenanted } from "../http/tenant.js";
import {
  cancelScheduledReply,
  getSendDelay,
  listOpenScheduledReplies,
  sendScheduledReplyNow,
  setSendDelay,
} from "../scheduled-replies.js";

export default async function scheduledReplyRoutes(app: FastifyInstance) {
  app.get("/tickets/:id/scheduled-replies", tenanted(async (tenantId, req) => {
    const { id } = req.params as { id: string };
    return { scheduledReplies: await listOpenScheduledReplies(tenantId, id) };
  }));

  // The body comes back so the composer can offer the text again.
  app.post("/scheduled-replies/:id/cancel", tenanted(async (tenantId, req, reply) => {
    const { id } = req.params as { id: string };
    const row = await cancelScheduledReply(tenantId, id);
    if (!row) return reply.code(409).send({ error: "already_sent", detail: "This reply is already being sent." });
    return { cancelled: true, body: row.body, source: row.source };
  }));

  app.post("/scheduled-replies/:id/send", tenanted(async (tenantId, req, reply) => {
    const { id } = req.params as { id: string };
    const out = await sendScheduledReplyNow(tenantId, id, app.log).catch(() => undefined);
    if (out === null) return reply.code(409).send({ error: "not_scheduled", detail: "This reply was already sent or cancelled." });
    if (out === undefined) return reply.code(502).send({ error: "send_failed", detail: "Couldn't send it now. It will be retried." });
    return { sent: true, messageId: out.messageId };
  }));

  app.get("/settings/replies", tenanted(async (tenantId) => ({ sendDelaySeconds: await getSendDelay(tenantId) })));

  app.put("/settings/replies", tenanted(async (tenantId, req, reply) => {
    const parsed = ReplySettingsInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return { sendDelaySeconds: await setSendDelay(tenantId, parsed.data.sendDelaySeconds) };
  }));
}
