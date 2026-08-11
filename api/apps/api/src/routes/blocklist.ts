import type { FastifyInstance } from "fastify";
import { BlockSenderInput } from "@repo/contracts";
import { tenanted } from "../http/tenant.js";
import { listBlockedSenders, blockSender, unblockSender } from "../blocklist.js";

// Sender blocklist — the manual manager behind Settings. "Mark as spam" adds entries automatically;
// this is where an admin reviews them, adds a block by hand, or removes one. Enforcement lives at the
// inbound seam (handleInboundEmail → isSenderBlocked). Admin-gated via ADMIN_ROUTES in rbac.ts.
export default async function blocklistRoutes(app: FastifyInstance): Promise<void> {
  app.get("/blocklist", tenanted(async (tenantId) => ({ blocked: await listBlockedSenders(tenantId) })));

  app.post("/blocklist", tenanted(async (tenantId, req, reply) => {
    const parsed = BlockSenderInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const row = await blockSender(tenantId, {
      handle: parsed.data.handle,
      scope: parsed.data.scope,
      channelType: parsed.data.channelType,
      reason: parsed.data.reason ?? null,
      createdBy: req.session?.userId ?? null,
    });
    if (!row) return reply.code(400).send({ error: "invalid handle" });
    return reply.code(201).send(row);
  }));

  app.delete("/blocklist/:id", tenanted(async (tenantId, req, reply) => {
    const gone = await unblockSender(tenantId, (req.params as { id: string }).id);
    if (!gone) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  }));
}
