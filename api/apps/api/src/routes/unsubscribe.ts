import type { FastifyInstance, FastifyReply } from "fastify";
import { verifyUnsubscribeToken, setSubscription } from "../unsubscribe.js";
import { getContactSubscriptionState, setTopicOptout, isUuid } from "../subscription-topics.js";

// Public marketing opt-out lane (PUBLIC_ROUTES exempt). No session: the signed token in the URL is
// the whole authorization — it names exactly one (tenant, contact) and verifies against the
// server-side HMAC secret (unsubscribe.ts), so the only thing a holder can do is change THAT
// contact's own subscriptions.
//
// Multi-level (0110): a broadcast tagged with a subscription topic sends a link carrying `?t=<topic>`
// — clicking (or the RFC 8058 one-click POST) opts out of just THAT topic; without `?t` it's the
// global opt-out (unsubscribe from everything). The preference center (/u/:token/preferences) is the
// full surface: toggle each topic + the global switch. Dependency-free server-rendered HTML — every
// action is a link or a tiny form, no client JS.

/** Escape text destined for HTML (topic names are tenant-authored → untrusted on this public page). */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

const SHELL_HEAD = `<meta name="viewport" content="width=device-width,initial-scale=1">`;
const BODY_OPEN = `<body style="margin:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:460px;margin:80px auto;padding:0 16px">
    <p style="font-size:18px;font-weight:700;color:#18181b;margin:0 0 16px">Noola<span style="color:#e8a33d">.</span></p>`;
const BODY_CLOSE = `  </div>\n</body></html>`;

/** A simple confirmation card. `manageHref` (when given) links to the full preference center. */
function page(reply: FastifyReply, status: number, title: string, detail: string, opts?: { undoHref?: string; manageHref?: string }): FastifyReply {
  const undo = opts?.undoHref
    ? `<p style="margin:16px 0 0;font-size:13px;color:#71717a">Changed your mind? <a href="${opts.undoHref}" style="color:#b45309">Resubscribe</a>.</p>`
    : "";
  const manage = opts?.manageHref
    ? `<p style="margin:12px 0 0;font-size:13px;color:#71717a"><a href="${opts.manageHref}" style="color:#b45309">Manage all your email preferences</a>.</p>`
    : "";
  return reply
    .code(status)
    .header("content-type", "text/html; charset=utf-8")
    .send(`<!doctype html>
<html><head>${SHELL_HEAD}<title>${esc(title)}</title></head>
${BODY_OPEN}
    <div style="background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:28px">
      <p style="font-size:16px;font-weight:600;color:#18181b;margin:0">${esc(title)}</p>
      <p style="font-size:14px;line-height:1.6;color:#52525b;margin:8px 0 0">${detail}</p>
      ${undo}
      ${manage}
    </div>
${BODY_CLOSE}`);
}

export default async function unsubscribeRoutes(app: FastifyInstance): Promise<void> {
  // RFC 8058 one-click POSTs arrive as form-urlencoded ("List-Unsubscribe=One-Click"); the
  // app-level urlencoded parser (server.ts) covers it. The preference-center forms below also POST
  // form-urlencoded and read req.body fields.

  // GET /u/preview — the honest stand-in the composer preview points its footer "Unsubscribe" link
  // at (a static route, so it wins over /u/:token). Real emails carry a working per-recipient link;
  // this just explains that, instead of the old dead example.com placeholder.
  app.get("/u/preview", async (_req, reply) =>
    page(
      reply,
      200,
      "Unsubscribe preview",
      "This is a preview. Every real email carries a working, one-click unsubscribe link unique to its recipient — this placeholder stands in while you compose.",
    ),
  );

  const readTopic = (req: { query?: unknown }): string | null => {
    const t = (req.query as { t?: string } | undefined)?.t;
    return t && isUuid(t) ? t : null;
  };

  // GET /u/:token — the footer-link landing. `?t=<topic>` scopes the opt-out to that topic; `?all=1`
  // forces a global opt-out (the "unsubscribe from everything" link); neither → global (legacy).
  app.get("/u/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const id = verifyUnsubscribeToken(token);
    if (!id) return page(reply, 404, "This link is invalid", "The unsubscribe link is malformed or no longer matches a contact. Nothing was changed.");
    const topic = readTopic(req);
    const forceAll = (req.query as { all?: string } | undefined)?.all === "1";

    if (topic && !forceAll) {
      // Topic opt-out. Resolve the state to name the topic + confirm it exists.
      const state = await getContactSubscriptionState(id.tenantId, id.contactId);
      const t = state.topics.find((x) => x.id === topic);
      if (!t) return page(reply, 404, "This link is invalid", "That subscription no longer exists. Nothing was changed.", { manageHref: `/u/${token}/preferences` });
      await setTopicOptout(id.tenantId, id.contactId, topic, true);
      return page(
        reply,
        200,
        `Unsubscribed from ${esc(t.name)}`,
        `You'll no longer receive <strong>${esc(t.name)}</strong> emails from this workspace. Other subscriptions are unchanged, and replies about your open support conversations are unaffected.`,
        { undoHref: `/u/${token}/undo?t=${topic}`, manageHref: `/u/${token}/preferences` },
      );
    }

    // Global opt-out.
    const who = await setSubscription(id.tenantId, id.contactId, true);
    if (!who) return page(reply, 404, "This link is invalid", "The link no longer matches a contact. Nothing was changed.");
    const address = who.email ? ` (${esc(who.email)})` : "";
    return page(
      reply,
      200,
      "You're unsubscribed",
      `You${address} will no longer receive marketing messages from this workspace. Replies about your open support conversations are unaffected.`,
      { undoHref: `/u/${token}/undo`, manageHref: `/u/${token}/preferences` },
    );
  });

  // RFC 8058 one-click: mail clients POST here from the List-Unsubscribe header. Honors `?t=<topic>`
  // so one-click opts out of exactly what the recipient was receiving. Bare 200, nothing rendered.
  app.post("/u/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const id = verifyUnsubscribeToken(token);
    if (!id) return reply.code(404).send({ error: "invalid token" });
    const topic = readTopic(req);
    const ok = topic
      ? await setTopicOptout(id.tenantId, id.contactId, topic, true)
      : !!(await setSubscription(id.tenantId, id.contactId, true));
    if (!ok) return reply.code(404).send({ error: "invalid token" });
    return { ok: true };
  });

  // GET /u/:token/undo — resubscribe (misclick recovery). `?t=<topic>` re-subscribes to that topic;
  // otherwise clears the global opt-out.
  app.get("/u/:token/undo", async (req, reply) => {
    const { token } = req.params as { token: string };
    const id = verifyUnsubscribeToken(token);
    if (!id) return page(reply, 404, "This link is invalid", "The link is malformed or no longer matches a contact. Nothing was changed.");
    const topic = readTopic(req);
    if (topic) {
      const ok = await setTopicOptout(id.tenantId, id.contactId, topic, false);
      if (!ok) return page(reply, 404, "This link is invalid", "That subscription no longer exists.", { manageHref: `/u/${token}/preferences` });
      return page(reply, 200, "You're resubscribed", "You'll receive these emails from this workspace again.", { manageHref: `/u/${token}/preferences` });
    }
    const who = await setSubscription(id.tenantId, id.contactId, false);
    if (!who) return page(reply, 404, "This link is invalid", "The link no longer matches a contact. Nothing was changed.");
    return page(reply, 200, "You're resubscribed", "You'll receive marketing messages from this workspace again.", { manageHref: `/u/${token}/preferences` });
  });

  // GET /u/:token/preferences — the full preference center: the global switch + every topic, each a
  // one-tap form. Server-rendered; a POST applies and 303-redirects back here so refresh is clean.
  app.get("/u/:token/preferences", async (req, reply) => {
    const { token } = req.params as { token: string };
    const id = verifyUnsubscribeToken(token);
    if (!id) return page(reply, 404, "This link is invalid", "The link is malformed or no longer matches a contact.");
    const state = await getContactSubscriptionState(id.tenantId, id.contactId);
    return reply.code(200).header("content-type", "text/html; charset=utf-8").send(renderPreferences(token, state));
  });

  // POST /u/:token/preferences — form action. body.action ∈ topic_off|topic_on|all_off|all_on,
  // body.topic = topic id for the topic_* actions. Applies, then 303 back to the center.
  app.post("/u/:token/preferences", async (req, reply) => {
    const { token } = req.params as { token: string };
    const id = verifyUnsubscribeToken(token);
    if (!id) return page(reply, 404, "This link is invalid", "The link is malformed or no longer matches a contact.");
    const b = (req.body ?? {}) as { action?: string; topic?: string };
    switch (b.action) {
      case "all_off":
        await setSubscription(id.tenantId, id.contactId, true);
        break;
      case "all_on":
        await setSubscription(id.tenantId, id.contactId, false);
        break;
      case "topic_off":
        if (b.topic && isUuid(b.topic)) await setTopicOptout(id.tenantId, id.contactId, b.topic, true);
        break;
      case "topic_on":
        if (b.topic && isUuid(b.topic)) await setTopicOptout(id.tenantId, id.contactId, b.topic, false);
        break;
    }
    return reply.code(303).header("location", `/u/${token}/preferences`).send();
  });
}

/** Render the preference center. Each row is a tiny POST form; the button's label is the action a
 *  tap performs (Unsubscribe when currently subscribed, Resubscribe when not). Global opt-out
 *  overrides everything, so when it's on the topic rows read as inactive. */
function renderPreferences(
  token: string,
  state: { globallyUnsubscribed: boolean; topics: { id: string; name: string; description: string; subscribed: boolean }[] },
): string {
  const btn = (label: string, tone: "off" | "on") =>
    `<button type="submit" style="border:1px solid ${tone === "off" ? "#e4e4e7" : "#e8a33d"};background:${tone === "off" ? "#fff" : "#fff7ed"};color:${tone === "off" ? "#52525b" : "#b45309"};font-size:13px;font-weight:600;padding:6px 12px;border-radius:8px;cursor:pointer">${label}</button>`;

  const form = (action: string, topic: string | null, inner: string) =>
    `<form method="post" action="/u/${token}/preferences" style="margin:0">
       <input type="hidden" name="action" value="${action}">
       ${topic ? `<input type="hidden" name="topic" value="${topic}">` : ""}
       ${inner}
     </form>`;

  const globalRow = state.globallyUnsubscribed
    ? `<div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:16px;margin:0 0 16px">
         <p style="font-size:14px;font-weight:600;color:#b45309;margin:0">You're unsubscribed from everything</p>
         <p style="font-size:13px;color:#71717a;margin:6px 0 12px">You won't receive any marketing emails. Resubscribe to manage individual topics.</p>
         ${form("all_on", null, btn("Resubscribe to all", "on"))}
       </div>`
    : `<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 0;border-bottom:1px solid #f4f4f5">
         <div><p style="font-size:14px;font-weight:600;color:#18181b;margin:0">All marketing emails</p>
         <p style="font-size:13px;color:#71717a;margin:4px 0 0">Turn everything off in one tap.</p></div>
         ${form("all_off", null, btn("Unsubscribe from all", "off"))}
       </div>`;

  const topicRows = state.topics.length === 0
    ? `<p style="font-size:14px;color:#71717a;margin:16px 0 0">No topic-level lists — this workspace sends a single stream.</p>`
    : state.topics.map((t) => {
        const active = !state.globallyUnsubscribed && t.subscribed;
        const control = state.globallyUnsubscribed
          ? `<span style="font-size:12px;color:#a1a1aa">off (all)</span>`
          : t.subscribed
            ? form("topic_off", t.id, btn("Unsubscribe", "off"))
            : form("topic_on", t.id, btn("Resubscribe", "on"));
        return `<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 0;border-bottom:1px solid #f4f4f5">
           <div style="min-width:0"><p style="font-size:14px;font-weight:600;color:${active ? "#18181b" : "#a1a1aa"};margin:0">${esc(t.name)}</p>
           ${t.description ? `<p style="font-size:13px;color:#71717a;margin:4px 0 0">${esc(t.description)}</p>` : ""}</div>
           ${control}
         </div>`;
      }).join("");

  return `<!doctype html>
<html><head>${SHELL_HEAD}<title>Email preferences</title></head>
${BODY_OPEN}
    <div style="background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:28px">
      <p style="font-size:16px;font-weight:600;color:#18181b;margin:0 0 4px">Email preferences</p>
      <p style="font-size:13px;color:#71717a;margin:0 0 20px">Choose what you hear about. Replies to your open support conversations are always delivered.</p>
      ${globalRow}
      ${topicRows}
    </div>
${BODY_CLOSE}`;
}
