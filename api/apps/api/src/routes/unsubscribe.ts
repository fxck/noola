import type { FastifyInstance, FastifyReply } from "fastify";
import { verifyUnsubscribeToken, setSubscription } from "../unsubscribe.js";

// Public marketing opt-out lane (PUBLIC_ROUTES exempt). No session: the signed token in the
// URL is the whole authorization — it names exactly one (tenant, contact) and verifies
// against the server-side HMAC secret (unsubscribe.ts), so the only thing a holder can do
// is flip that contact's own subscription bit. GET renders a human confirmation page (the
// footer-link click), POST is the RFC 8058 one-click endpoint mail clients call from the
// List-Unsubscribe header, and /undo covers the misclick.

/** The whole opt-out UX is two sentences on a card — keep it dependency-free and quiet. */
function page(reply: FastifyReply, status: number, title: string, detail: string, undoHref?: string): FastifyReply {
  const undo = undoHref
    ? `<p style="margin:16px 0 0;font-size:13px;color:#71717a">Changed your mind? <a href="${undoHref}" style="color:#b45309">Resubscribe</a>.</p>`
    : "";
  return reply
    .code(status)
    .header("content-type", "text/html; charset=utf-8")
    .send(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:420px;margin:96px auto;padding:0 16px">
    <p style="font-size:18px;font-weight:700;color:#18181b;margin:0 0 16px">Noola<span style="color:#e8a33d">.</span></p>
    <div style="background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:28px">
      <p style="font-size:16px;font-weight:600;color:#18181b;margin:0">${title}</p>
      <p style="font-size:14px;line-height:1.6;color:#52525b;margin:8px 0 0">${detail}</p>
      ${undo}
    </div>
  </div>
</body></html>`);
}

export default async function unsubscribeRoutes(app: FastifyInstance): Promise<void> {
  // RFC 8058 one-click POSTs arrive as form-urlencoded ("List-Unsubscribe=One-Click"); the body
  // carries nothing we need. The app-level urlencoded parser (server.ts, added for Slack slash
  // commands) now covers it — the previous plugin-local parser here would collide with it.

  app.get("/u/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const id = verifyUnsubscribeToken(token);
    const who = id && (await setSubscription(id.tenantId, id.contactId, true));
    if (!who) return page(reply, 404, "This link is invalid", "The unsubscribe link is malformed or no longer matches a contact. Nothing was changed.");
    const address = who.email ? ` (${who.email})` : "";
    return page(
      reply,
      200,
      "You're unsubscribed",
      `You${address} will no longer receive marketing messages from this workspace. Replies about your open support conversations are unaffected.`,
      `/u/${token}/undo`,
    );
  });

  // RFC 8058 one-click: mail clients POST here from the List-Unsubscribe header without
  // rendering anything, so the response is a bare 200.
  app.post("/u/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const id = verifyUnsubscribeToken(token);
    const who = id && (await setSubscription(id.tenantId, id.contactId, true));
    if (!who) return reply.code(404).send({ error: "invalid token" });
    return { ok: true };
  });

  app.get("/u/:token/undo", async (req, reply) => {
    const { token } = req.params as { token: string };
    const id = verifyUnsubscribeToken(token);
    const who = id && (await setSubscription(id.tenantId, id.contactId, false));
    if (!who) return page(reply, 404, "This link is invalid", "The link is malformed or no longer matches a contact. Nothing was changed.");
    return page(reply, 200, "You're resubscribed", "You'll receive marketing messages from this workspace again.");
  });
}
