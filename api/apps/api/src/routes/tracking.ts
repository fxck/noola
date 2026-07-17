import type { FastifyInstance } from "fastify";
import { verifyTrackToken, trackOpen, trackClick, PIXEL_GIF } from "../tracking.js";

// Public engagement-tracking lane (PUBLIC_ROUTES exempt). The signed token is the whole
// authorization (tracking.ts); a bad token still returns the pixel / a safe redirect —
// tracking must never break the customer's reading experience. /t/c refuses to redirect
// anywhere the token wasn't minted for (the destination is inside the MAC), which closes
// the open-redirect hole a naive ?u= would be.

export default async function trackingRoutes(app: FastifyInstance): Promise<void> {
  app.get("/t/o/:token", async (req, reply) => {
    const id = verifyTrackToken((req.params as { token: string }).token);
    if (id) void trackOpen(id.tenantId, id.recipientId).catch(() => {});
    return reply
      .header("content-type", "image/gif")
      .header("cache-control", "no-store, no-cache, must-revalidate, private")
      .send(PIXEL_GIF);
  });

  app.get("/t/c/:token", async (req, reply) => {
    const url = (req.query as { u?: string } | undefined)?.u ?? "";
    const id = verifyTrackToken((req.params as { token: string }).token, url);
    if (!id || !/^https?:\/\//i.test(url)) {
      // Unverifiable → no redirect (that would be an open redirect), just a plain notice.
      return reply.code(404).header("content-type", "text/plain; charset=utf-8").send("This link is invalid.");
    }
    void trackClick(id.tenantId, id.recipientId).catch(() => {});
    return reply.redirect(url, 302);
  });
}
