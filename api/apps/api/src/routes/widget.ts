import type { FastifyInstance, FastifyRequest } from "fastify";
import { withTenant } from "@repo/db";
import {
  SyntheticMessageInput,
  PublicAskInput,
  PublicConversationInput,
  WidgetKeyInput,
  WidgetKeyUpdateInput,
  PublicIdentifyInput,
  PublicTrackInput,
} from "@repo/contracts";
import { randomUUID } from "node:crypto";
import { tenanted } from "../http/tenant.js";
import { ingestInbound } from "../ingest.js";
import { createAttachment, claimAttachments, attachmentsForTicket, type AttachmentRow } from "../attachments.js";
import { putBuffer, getObject } from "../storage.js";
import { indexTicket } from "../search.js";
import { suggestForQuery, suggestForQueryStream } from "../copilot.js";
import { resolveWidgetKey, originAllowed, listWidgetKeys, createWidgetKey, updateWidgetKey, deleteWidgetKey, setIdentitySecret, resolveVerifiedIdentity } from "../widget.js";
import { upsertContact, bumpContactSeen } from "../contacts.js";
import { trackEvent } from "../contact-events.js";
import { listPublicArticles, listPublicCollections, getPublicArticleBySlug, searchPublicArticles } from "../kb.js";
import { WIDGET_JS } from "../widget-embed.js";
import { ANSWERS_JS } from "../answers-embed.js";

// The customer-facing embeddable surface: the synthetic inbound channel, the Ask-AI widget lane,
// the public help center + support-form deflection, the two-way messenger conversation poll, the
// embed script itself, and (authed) widget-key management. Every public route resolves its tenant
// from a widget key (pre-context BYPASSRLS lookup) + a per-key domain allowlist — no session; all
// are listed in server.ts's PUBLIC_ROUTES. widget-key management is the one authed, tenant-scoped lane.
// Authoritative AI mode for a widget conversation (see migration 0075). Muted on human handoff so
// neither the /public/ask lane nor the autoreply/automations engine answers past it.
async function setWidgetAssistantMode(tenantId: string, conversationId: string, enabled: boolean): Promise<void> {
  await withTenant(tenantId, (c) =>
    c.query(
      `UPDATE tickets SET assistant_enabled = $2 WHERE channel_type = 'widget' AND external_channel_id = $1`,
      [conversationId, enabled],
    ),
  );
}
async function widgetAssistantEnabled(tenantId: string, ticketId: string): Promise<boolean> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(`SELECT assistant_enabled FROM tickets WHERE id = $1 LIMIT 1`, [ticketId]);
    return r.rowCount ? r.rows[0].assistant_enabled !== false : true;
  });
}

const WIDGET_ATTACH_DATA_URL = /^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/i;
const WIDGET_ATTACH_MAX_BYTES = 15 * 1024 * 1024; // 15MB raw, mirrors the agent upload cap

// Store the visitor's inline files in object-storage and claim them onto the just-persisted widget
// message — the same first-class message_attachments rows an agent reply produces, so the agent
// console renders them with zero extra work. Bad/oversized entries are skipped, never fatal.
async function persistWidgetAttachments(
  tenantId: string,
  ticketId: string,
  messageId: string,
  files: Array<{ dataUrl: string; filename: string }>,
): Promise<AttachmentRow[]> {
  const out: AttachmentRow[] = [];
  for (const f of files) {
    const m = WIDGET_ATTACH_DATA_URL.exec(f.dataUrl ?? "");
    if (!m) continue;
    const contentType = m[1].toLowerCase();
    const bytes = Buffer.from(m[2], "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > WIDGET_ATTACH_MAX_BYTES) continue;
    const safe = (f.filename ?? "file").replace(/^.*[\\/]/, "").replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "file";
    const storageKey = `attachments/${tenantId}/${randomUUID()}-${safe}`;
    await putBuffer(storageKey, bytes, contentType);
    const row = await createAttachment(tenantId, {
      ticketId, uploadedBy: null, filename: safe, contentType, sizeBytes: bytes.byteLength, storageKey,
    });
    await claimAttachments(tenantId, ticketId, messageId, [row.id]);
    out.push(row);
  }
  return out;
}

export default async function widgetRoutes(app: FastifyInstance): Promise<void> {
  // Synthetic inbound channel — stands in for a real channel; funnels through the shared
  // ingestInbound() core (see ingest.ts). A customer has no agent session by nature.
  app.post("/synthetic/messages", async (req, reply) => {
    const parsed = SyntheticMessageInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const input = parsed.data;

    const result = await ingestInbound({
      tenantId: input.tenantId,
      body: input.body,
      authorType: input.authorType,
      idempotencyKey: input.idempotencyKey,
      ticketId: input.ticketId,
      subject: input.subject,
    });

    // Index the ticket into Typesense (tenant-scoped doc), best-effort.
    if (!result.replay) {
      void indexTicket({
        id: result.ticketId,
        tenant_id: input.tenantId,
        subject: result.subject,
        body: input.body,
        created_at: Math.floor(Date.now() / 1000),
      }).catch((err) => app.log.warn({ err }, "typesense index failed"));
    }

    return reply.code(result.replay ? 200 : 201).send({
      replay: result.replay,
      ticketId: result.ticketId,
      messageId: result.messageId,
      subject: result.subject,
    });
  });

  // ---- Ask-AI embeddable widget ------------------------------------------
  // The public, unauthenticated lane for a customer-site widget. The widget key resolves the
  // tenant (pre-tenant BYPASSRLS lookup), a per-key domain allowlist gates the origin, and the
  // same RAG core that drafts agent replies (suggestForQuery) answers.
  //
  // Intercom model — a widget conversation is ONE persisted ticket carrying the whole thread, so an
  // agent sees the full AI context (not just the post-escalation message). Every turn is ingested:
  //   - the visitor's question  → a CUSTOMER message (threads by conversationId + identity)
  //   - the AI's answer          → an AGENT message on the SAME ticket (origin 'automation' so the
  //     AI's own reply can't re-trigger the rules engine). Ingesting the agent message also fans it
  //     out over the widget WS (widget:<conversationId>), so the widget renders each reply from ONE
  //     source-of-truth (dedupe by message id) — the HTTP response carries that id to seed the dedupe.
  //   - escalate:true            → the visitor's handoff message as a CUSTOMER inbound on the SAME
  //     open ticket (no new ticket). A customer message leaves whose_turn='us', so the conversation
  //     surfaces in the human "needs reply" queue with the full prior transcript intact. (A normal AI
  //     answer flips whose_turn back to 'customer', so AI handling never forces the human queue.)
  // bodyLimit lifted to fit base64-encoded inline attachments (~1.35× raw) + the JSON envelope.
  app.post("/public/ask", { bodyLimit: 40 * 1024 * 1024 }, async (req, reply) => {
    const parsed = PublicAskInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { key, question, conversationId, escalate, resumeAi, name, userId, userHash, userJwt } = parsed.data;
    const files = parsed.data.attachments ?? [];
    const text = question.trim();
    if (!text && files.length === 0) return reply.code(400).send({ error: "message is empty" });

    const wk = await resolveWidgetKey(key);
    if (!wk) return reply.code(401).send({ error: "invalid widget key" });

    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (!originAllowed(wk.allowedDomains, origin)) {
      return reply.code(403).send({ error: "origin not allowed for this widget key" });
    }

    // Identity verification (Intercom-parity): the identity is either proven by a signed JWT
    // (identity from its claims) or a user_hash HMAC. When verification is ENABLED, an unproven
    // identified claim is DOWNGRADED to anonymous — dropped so the message can't be threaded into
    // someone else's contact/conversation.
    const rid = resolveVerifiedIdentity(wk, { userId, email: parsed.data.email, userHash, userJwt });
    let email = rid.email ?? undefined;
    let identName = name ?? null;
    if (wk.config.verifyIdentity && !rid.verified) {
      email = undefined;
      identName = null;
    }

    // AI mode is authoritative on the ticket. Escalation MUTES the assistant (set BEFORE ingest so the
    // handoff message itself can't trigger a bot reply); "Ask the assistant" un-mutes it. Both target
    // the existing widget ticket by its conversation handle (external_channel_id).
    if (conversationId && (escalate || resumeAi)) {
      await setWidgetAssistantMode(wk.tenantId, conversationId, !escalate && resumeAi === true);
    }

    // Persist the visitor's message onto the widget ticket (creates it on the first turn, then threads
    // every later turn onto the same open ticket by contact identity). An attachment-only turn still
    // needs a body — fall back to the filenames so the agent sees what was sent.
    const body = text || files.map((f) => f.filename).join(", ") || "(attachment)";
    const inbound = await ingestInbound({
      tenantId: wk.tenantId,
      body,
      authorType: "customer",
      channelType: "widget",
      externalChannelId: conversationId ?? null,
      subject: body.slice(0, 80),
      identity: { externalId: conversationId ?? null, email: email ?? null, name: identName },
    });

    // Store + claim any inline files onto the persisted message (first-class attachments the agent
    // console renders natively; the widget re-fetches them via /public/attachment).
    const attached = files.length ? await persistWidgetAttachments(wk.tenantId, inbound.ticketId, inbound.messageId, files) : [];
    if (inbound.contactId) void bumpContactSeen(wk.tenantId, inbound.contactId); // presence, best-effort

    // Escalation: the question is already persisted above (whose_turn='us' → human queue) and the
    // assistant is muted. The human takes over on the existing ticket with the whole thread visible.
    if (escalate) {
      return reply.code(201).send({ escalated: true, conversationId: inbound.ticketId, messageId: inbound.messageId });
    }

    // No AI on an attachment-only turn (a file is for a human to look at, not a RAG query), and none
    // in human mode — persist the message for the agent, bot stays silent (single source of truth).
    if (!text || !(await widgetAssistantEnabled(wk.tenantId, inbound.ticketId))) {
      return { deferred: true, conversationId: inbound.ticketId, messageId: inbound.messageId, attachments: attached };
    }

    try {
      const s = await suggestForQuery(wk.tenantId, question, { audience: "public" });
      // Persist the AI answer as an agent message on the SAME ticket → threads + fans out over the
      // widget WS. origin:'automation' suppresses re-triggering the rules engine off the AI's reply.
      const answerMsg = await ingestInbound({
        tenantId: wk.tenantId,
        body: s.draft,
        authorType: "agent",
        ticketId: inbound.ticketId,
        channelType: "widget",
        origin: "automation",
      });
      return {
        answer: s.draft,
        citations: s.citations.map((c) => ({ title: c.title, snippet: c.snippet })),
        confidence: s.confidence,
        conversationId: inbound.ticketId,
        // The persisted agent-message id — the widget renders the answer once and dedupes the WS/poll
        // echo of the same id, so there's never a duplicated bubble.
        messageId: answerMsg.messageId,
      };
    } catch (err) {
      app.log.error({ err }, "public ask failed");
      // The question is already persisted (agent sees it); only the AI answer is unavailable.
      return reply.code(502).send({ error: "answer unavailable" });
    }
  });

  // Streaming sibling of /public/ask (Server-Sent Events). Same trust model + ingest, but the AI
  // answer arrives token-by-token so the widget renders it live (Intercom-style perceived speed)
  // instead of blocking on the full generation. The customer message is persisted first; the answer
  // is persisted (agent/automation) only once the stream completes, then fanned out over the widget
  // WS + returned by the terminal `done` event (messageId seeds the widget's dedupe so poll/WS
  // echoes of the same id never double-render). SSE frames:
  //   event: delta  data: {"t":"…"}                          — an incremental text chunk
  //   event: done   data: {"messageId","conversationId","confidence","citations"} — final, persisted
  //   event: error  data: {"error":"…"}                       — generation failed after ingest
  // The widget uses this lane only for AI-mode text turns; escalate / human-mode / attachment-only
  // turns still use /public/ask (no streamed answer to produce).
  app.post("/public/ask/stream", { bodyLimit: 40 * 1024 * 1024 }, async (req, reply) => {
    const parsed = PublicAskInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { key, question, conversationId, name, userId, userHash, userJwt } = parsed.data;
    const text = question.trim();
    if (!text) return reply.code(400).send({ error: "message is empty" });

    const wk = await resolveWidgetKey(key);
    if (!wk) return reply.code(401).send({ error: "invalid widget key" });
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (!originAllowed(wk.allowedDomains, origin)) {
      return reply.code(403).send({ error: "origin not allowed for this widget key" });
    }
    // Same identity-verification gate as /public/ask — drop an unverified identity claim.
    const rid = resolveVerifiedIdentity(wk, { userId, email: parsed.data.email, userHash, userJwt });
    let email = rid.email ?? undefined;
    let identName = name ?? null;
    if (wk.config.verifyIdentity && !rid.verified) {
      email = undefined;
      identName = null;
    }

    // Persist the visitor's message onto the widget ticket (creates/threads by identity), exactly
    // like /public/ask, BEFORE opening the stream — so a mid-stream disconnect never loses the ask.
    const inbound = await ingestInbound({
      tenantId: wk.tenantId,
      body: text,
      authorType: "customer",
      channelType: "widget",
      externalChannelId: conversationId ?? null,
      subject: text.slice(0, 80),
      identity: { externalId: conversationId ?? null, email: email ?? null, name: identName },
    });
    if (inbound.contactId) void bumpContactSeen(wk.tenantId, inbound.contactId);

    // Not in AI mode → nothing to stream; tell the widget to fall back to its human-queue rendering.
    if (!(await widgetAssistantEnabled(wk.tenantId, inbound.ticketId))) {
      return reply.code(200).send({ deferred: true, conversationId: inbound.ticketId, messageId: inbound.messageId });
    }

    // Hand the socket to us: write SSE frames on reply.raw. CORS headers are set explicitly because
    // hijack bypasses the @fastify/cors reply-header staging; the origin is already allowlist-checked.
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no", // defeat proxy buffering so tokens flush immediately
      "access-control-allow-origin": origin ?? "*",
      vary: "Origin",
    });
    const send = (event: string, data: unknown): void => {
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    // A heartbeat comment every 15s keeps intermediaries from idling the connection out on a slow model.
    const hb = setInterval(() => raw.write(": ping\n\n"), 15_000);

    try {
      const stream = suggestForQueryStream(wk.tenantId, question, { audience: "public" });
      // Manual iteration so we capture the generator's RETURN value (the final Suggestion).
      let suggestion: Awaited<ReturnType<typeof suggestForQuery>>;
      for (;;) {
        const step = await stream.next();
        if (step.done) {
          suggestion = step.value;
          break;
        }
        if (step.value?.delta) send("delta", { t: step.value.delta });
      }

      // Persist the finished answer as an agent message on the SAME ticket → threads + fans out over
      // the widget WS. origin:'automation' stops the AI's own reply re-triggering the rules engine.
      const answerMsg = await ingestInbound({
        tenantId: wk.tenantId,
        body: suggestion.draft,
        authorType: "agent",
        ticketId: inbound.ticketId,
        channelType: "widget",
        origin: "automation",
      });
      send("done", {
        messageId: answerMsg.messageId,
        conversationId: inbound.ticketId,
        confidence: suggestion.confidence,
        citations: suggestion.citations.map((c) => ({ title: c.title, snippet: c.snippet })),
      });
    } catch (err) {
      app.log.error({ err }, "public ask stream failed");
      send("error", { error: "answer unavailable" });
    } finally {
      clearInterval(hb);
      raw.end();
    }
  });

  // ---- Public help center (unauthenticated, widget-key-scoped) -----------
  // The published+public subset of the KB, served for an on-brand help center + support-form
  // deflection. Tenant resolves from a widget key (?key=); the kb.ts public queries hard-filter
  // status='published' AND visibility='public' so drafts/internal articles can never leak.
  async function tenantFromWidgetQuery(req: FastifyRequest): Promise<string | null> {
    const key = (req.query as { key?: string }).key;
    if (!key) return null;
    const wk = await resolveWidgetKey(key);
    return wk?.tenantId ?? null;
  }

  app.get("/public/kb", async (req, reply) => {
    const tenantId = await tenantFromWidgetQuery(req);
    if (!tenantId) return reply.code(401).send({ error: "invalid or missing widget key" });
    const collectionId = (req.query as { collection?: string }).collection || undefined;
    const [articles, collections] = await Promise.all([
      listPublicArticles(tenantId, collectionId),
      listPublicCollections(tenantId),
    ]);
    return { articles, collections };
  });

  app.get("/public/kb/search", async (req, reply) => {
    const tenantId = await tenantFromWidgetQuery(req);
    if (!tenantId) return reply.code(401).send({ error: "invalid or missing widget key" });
    const q = ((req.query as { q?: string }).q || "").trim();
    if (q.length < 2) return { articles: [] };
    return { articles: await searchPublicArticles(tenantId, q) };
  });

  app.get("/public/kb/:slug", async (req, reply) => {
    const tenantId = await tenantFromWidgetQuery(req);
    if (!tenantId) return reply.code(401).send({ error: "invalid or missing widget key" });
    const article = await getPublicArticleBySlug(tenantId, (req.params as { slug: string }).slug);
    if (!article) return reply.code(404).send({ error: "not found" });
    return { article };
  });

  // Support-form deflection: as a customer drafts a question, return the best-matching published
  // articles + an AI answer so they can self-serve before filing a ticket. Reuses the RAG core.
  app.post("/public/deflect", async (req, reply) => {
    const parsed = PublicAskInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const wk = await resolveWidgetKey(parsed.data.key);
    if (!wk) return reply.code(401).send({ error: "invalid widget key" });
    const q = parsed.data.question.trim();
    if (q.length < 3) return { articles: [], answer: null };
    const articles = await searchPublicArticles(wk.tenantId, q);
    let answer: { text: string; confidence: number | null } | null = null;
    try {
      const s = await suggestForQuery(wk.tenantId, q, { audience: "public" });
      answer = { text: s.draft, confidence: s.confidence };
    } catch {
      /* deflection degrades to article suggestions only */
    }
    return { articles, answer };
  });

  // ---- Messenger personalization + JS SDK (widget-key-scoped, public) ----
  // The embedded widget bootstraps from GET /public/config (accent/greeting/position/tabs the
  // admin set in Settings → Messenger), and the Noola(...) SDK feeds identity + activity through
  // /public/identify (upsert the contact + stamp last-seen) and /public/track (custom events).
  // All three resolve the tenant from the public widget key + the per-key domain allowlist — the
  // same trust model as /public/ask, no session.

  // Widget bootstrap: the personalization the embedded launcher/panel renders. Returns fully
  // populated config (defaults fill any gaps). Short cache — it's per-key and cheap.
  app.get("/public/config", async (req, reply) => {
    const key = (req.query as { key?: string }).key;
    const wk = key ? await resolveWidgetKey(key) : null;
    if (!wk) return reply.code(401).send({ error: "invalid or missing widget key" });
    reply.header("cache-control", "public, max-age=60");
    return { config: wk.config };
  });

  // Identify a visitor (Noola('boot'|'update')). Upserts the contact by external user_id/email
  // (attributes shallow-merge) and stamps a last-seen + last-page marker so an agent sees "user
  // activity" on the contact. Anonymous visitors (no user_id/email) are a 200 no-op.
  app.post("/public/identify", async (req, reply) => {
    const parsed = PublicIdentifyInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const wk = await resolveWidgetKey(parsed.data.key);
    if (!wk) return reply.code(401).send({ error: "invalid widget key" });
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (!originAllowed(wk.allowedDomains, origin)) {
      return reply.code(403).send({ error: "origin not allowed for this widget key" });
    }
    const { name, company, attributes, page, userHash, userJwt } = parsed.data;
    // Identity is either proven by a signed JWT (identity from its claims) or a user_hash HMAC.
    const rid = resolveVerifiedIdentity(wk, { userId: parsed.data.userId, email: parsed.data.email, userHash, userJwt });
    if (!rid.email && !rid.userId) return { ok: true, identified: false };
    // When verification is enabled, refuse to attach an identity that isn't proven — the visitor
    // stays anonymous rather than claiming someone else's profile. Off by default (opt-in, like Intercom).
    if (wk.config.verifyIdentity && !rid.verified) {
      return { ok: true, identified: false, verification: "failed" as const };
    }
    // Fold last-seen + last-page into the custom-attributes bag (jsonb shallow-merge on upsert),
    // so the agent-side contact profile shows recency without a dedicated column.
    const merged: Record<string, unknown> = { ...(attributes ?? {}), last_seen_at: new Date().toISOString() };
    if (page?.url) merged.last_page_url = page.url;
    if (page?.title) merged.last_page_title = page.title;
    const { contact } = await upsertContact(wk.tenantId, {
      external_id: rid.userId ?? undefined,
      email: rid.email ?? undefined,
      name,
      company,
      attributes: merged,
    });
    void bumpContactSeen(wk.tenantId, contact.id); // presence, best-effort
    return { ok: true, identified: true };
  });

  // Track a custom activity event (Noola('track', name, metadata?)). Upserts the contact by
  // identity first (so a track before any profile sync still lands). Anonymous → 200 no-op.
  app.post("/public/track", async (req, reply) => {
    const parsed = PublicTrackInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const wk = await resolveWidgetKey(parsed.data.key);
    if (!wk) return reply.code(401).send({ error: "invalid widget key" });
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (!originAllowed(wk.allowedDomains, origin)) {
      return reply.code(403).send({ error: "origin not allowed for this widget key" });
    }
    const rid = resolveVerifiedIdentity(wk, {
      userId: parsed.data.userId, email: parsed.data.email, userHash: parsed.data.userHash, userJwt: parsed.data.userJwt,
    });
    // Don't attribute an event to an unverified identity claim when verification is enabled.
    if (wk.config.verifyIdentity && (rid.email || rid.userId) && !rid.verified) {
      return { ok: true, recorded: false, verification: "failed" as const };
    }
    const event = await trackEvent(wk.tenantId, {
      externalId: rid.userId ?? undefined,
      email: rid.email ?? undefined,
      name: parsed.data.name,
      metadata: parsed.data.metadata,
    });
    if (!event) return { ok: true, recorded: false }; // anonymous — nothing to attribute to
    void bumpContactSeen(wk.tenantId, event.contact_id); // presence, best-effort
    return reply.code(201).send({ ok: true, recorded: true, id: event.id, contactId: event.contact_id });
  });

  // Messenger widget: poll the messages of a widget conversation (two-way live chat). The widget
  // key + its own generated conversationId (stored as external_channel_id on escalation) resolve
  // the ticket; we return its messages so the customer sees agent replies.
  app.post("/public/conversation", async (req, reply) => {
    const parsed = PublicConversationInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const wk = await resolveWidgetKey(parsed.data.key);
    if (!wk) return reply.code(401).send({ error: "invalid widget key" });
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (!originAllowed(wk.allowedDomains, origin)) {
      return reply.code(403).send({ error: "origin not allowed for this widget key" });
    }
    const data = await withTenant(wk.tenantId, async (c) => {
      const t = await c.query(
        `SELECT id, status, assistant_enabled, contact_id FROM tickets WHERE channel_type = 'widget' AND external_channel_id = $1 LIMIT 1`,
        [parsed.data.conversationId],
      );
      if (!t.rowCount) return null;
      // The poll IS the visitor's heartbeat — bump presence (throttled) while the widget is open.
      const cid = t.rows[0].contact_id as string | null;
      if (cid) void bumpContactSeen(wk.tenantId, cid);
      const m = await c.query(
        `SELECT m.id, m.author_type, m.author_id, m.body, m.created_at,
                u.name AS author_name, u.avatar_url AS author_avatar_url
           FROM messages m
           LEFT JOIN users u ON u.tenant_id = m.tenant_id AND u.id = m.author_id
          WHERE m.ticket_id = $1 ORDER BY m.created_at ASC LIMIT 200`,
        [t.rows[0].id],
      );
      return { ticketId: t.rows[0].id as string, status: t.rows[0].status as string, assistantEnabled: t.rows[0].assistant_enabled !== false, messages: m.rows };
    });
    if (!data) return { status: null, assistantEnabled: true, messages: [] };
    // Attachments per message (same seam the agent thread uses) — the widget renders images inline
    // and files as chips, fetching bytes from /public/attachment scoped to this conversation.
    const attByMsg = await attachmentsForTicket(wk.tenantId, data.ticketId);
    // Full authoritative transcript — the widget renders FROM this (single source of truth), so it
    // matches the agent console exactly. Only customer + agent turns surface (no internal notes/meta);
    // `id` lets the widget dedupe a message it may also receive live over the edge socket.
    return {
      status: data.status,
      assistantEnabled: data.assistantEnabled,
      messages: (data.messages as Array<{ id: string; author_type: string; author_id: string | null; body: string; created_at: string; author_name: string | null; author_avatar_url: string | null }>)
        .filter((x) => x.author_type === "customer" || x.author_type === "agent")
        .map((x) => {
          const isAgent = x.author_type === "agent";
          // AI answers post as an agent message with NO author_id (see /public/ask). A human agent
          // always carries an author_id → surface its name + avatar so the widget can render identity.
          const isAi = isAgent && !x.author_id;
          return {
            id: x.id,
            role: isAi ? "ai" : isAgent ? "agent" : "you",
            body: x.body,
            at: x.created_at,
            authorName: isAgent && !isAi ? x.author_name : null,
            authorAvatarUrl: isAgent && !isAi ? x.author_avatar_url : null,
            attachments: (attByMsg.get(x.id) ?? []).map((a) => ({
              id: a.id, filename: a.filename, contentType: a.content_type, size: a.size_bytes,
            })),
          };
        }),
    };
  });

  // List an IDENTIFIED visitor's past widget conversations (the Messages tab for a returning user).
  // Scoped by widget key → tenant AND the visitor's email (the cross-channel unifier), so it only
  // ever returns that person's own threads. Anonymous visitors (no email) get an empty list — their
  // conversations live only in their browser. Each entry is enough to render the list + reopen (the
  // conversationId is the widget handle); opening one hydrates the full transcript via /public/conversation.
  app.post("/public/conversations", async (req, reply) => {
    const body = (req.body ?? {}) as { key?: string; email?: string; userId?: string; userHash?: string; userJwt?: string };
    if (!body.key) return reply.code(400).send({ error: "key is required" });
    const wk = await resolveWidgetKey(body.key);
    if (!wk) return reply.code(401).send({ error: "invalid widget key" });
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (!originAllowed(wk.allowedDomains, origin)) {
      return reply.code(403).send({ error: "origin not allowed for this widget key" });
    }
    const rid = resolveVerifiedIdentity(wk, {
      userId: (body.userId ?? "").trim() || undefined,
      email: (body.email ?? "").trim() || undefined,
      userHash: body.userHash,
      userJwt: body.userJwt,
    });
    if (!rid.email && !rid.userId) return { conversations: [] }; // anonymous — nothing server-side to list
    // The history read is the sensitive one — it exposes another person's transcripts if the
    // identity is spoofed (the IDOR this whole feature closes). When verification is enabled,
    // require a valid proof (JWT or user_hash); when it's off, fall back to legacy identity trust
    // (Intercom-parity: history is only guarded once you opt into identity verification).
    if (wk.config.verifyIdentity && !rid.verified) {
      return { conversations: [] };
    }
    const email = rid.email ?? "";
    const userId = rid.userId ?? "";
    const rows = await withTenant(wk.tenantId, async (c) => {
      const contact = await c.query(
        `SELECT id FROM contacts
          WHERE (email <> '' AND lower(email) = lower($1)) OR (external_id IS NOT NULL AND external_id = $2)
          LIMIT 1`,
        [email, userId],
      );
      if (!contact.rowCount) return [];
      const r = await c.query(
        `SELECT t.external_channel_id AS cid, t.assistant_enabled, t.updated_at,
                (SELECT m.body FROM messages m
                   WHERE m.ticket_id = t.id AND m.author_type IN ('customer','agent')
                   ORDER BY m.created_at DESC LIMIT 1) AS last_body,
                (SELECT m.author_type FROM messages m
                   WHERE m.ticket_id = t.id AND m.author_type IN ('customer','agent')
                   ORDER BY m.created_at DESC LIMIT 1) AS last_author
           FROM tickets t
          WHERE t.channel_type = 'widget' AND t.external_channel_id IS NOT NULL AND t.contact_id = $1
          ORDER BY t.updated_at DESC LIMIT 20`,
        [contact.rows[0].id],
      );
      return r.rows;
    });
    return {
      conversations: (rows as Array<{ cid: string; assistant_enabled: boolean; updated_at: string; last_body: string | null; last_author: string | null }>).map((x) => ({
        conversationId: x.cid,
        lastBody: x.last_body ?? "",
        lastFromAgent: x.last_author === "agent",
        assistantEnabled: x.assistant_enabled !== false,
        updatedAt: x.updated_at,
      })),
    };
  });

  // Serve a widget attachment to the visitor (public). Scoped by widget key → tenant AND the
  // conversation handle, so a visitor can only fetch files from THEIR OWN conversation — never
  // guess another ticket's attachment id. Images serve inline (so <img src> works); everything
  // else downloads. `cid` is the conversationId (external_channel_id) the widget already holds.
  app.get("/public/attachment/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { key?: string; cid?: string };
    if (!q.key || !q.cid) return reply.code(400).send({ error: "key and cid are required" });
    const wk = await resolveWidgetKey(q.key);
    if (!wk) return reply.code(401).send({ error: "invalid widget key" });
    const meta = await withTenant(wk.tenantId, async (c) => {
      const r = await c.query(
        `SELECT a.storage_key, a.filename, a.content_type
           FROM message_attachments a
           JOIN tickets t ON t.id = a.ticket_id AND t.tenant_id = a.tenant_id
          WHERE a.id = $1 AND t.channel_type = 'widget' AND t.external_channel_id = $2
          LIMIT 1`,
        [id, q.cid],
      );
      return r.rowCount ? (r.rows[0] as { storage_key: string; filename: string; content_type: string }) : null;
    });
    if (!meta) return reply.code(404).send({ error: "not found" });
    const obj = await getObject(meta.storage_key);
    if (!obj) return reply.code(404).send({ error: "not found" });
    const ct = meta.content_type || obj.contentType;
    const inline = ct.startsWith("image/") && ct !== "image/svg+xml";
    return reply
      .type(ct)
      .header("cache-control", "private, max-age=3600")
      .header("content-disposition", `${inline ? "inline" : "attachment"}; filename="${meta.filename.replace(/"/g, "")}"`)
      .send(obj.body);
  });

  // Toggle the conversation's AI assistant on/off from the widget ("Talk to a human" mutes it,
  // "Ask the assistant" turns it back on). Authoritative + immediate, so the widget and the agent
  // console never disagree about who's answering. Origin-guarded like the other public lanes.
  app.post("/public/assistant-mode", async (req, reply) => {
    const body = (req.body ?? {}) as { key?: string; conversationId?: string; enabled?: boolean };
    if (!body.key || !body.conversationId || typeof body.enabled !== "boolean") {
      return reply.code(400).send({ error: "key, conversationId and enabled are required" });
    }
    const wk = await resolveWidgetKey(body.key);
    if (!wk) return reply.code(401).send({ error: "invalid widget key" });
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (!originAllowed(wk.allowedDomains, origin)) {
      return reply.code(403).send({ error: "origin not allowed for this widget key" });
    }
    await setWidgetAssistantMode(wk.tenantId, body.conversationId, body.enabled);
    return { ok: true, assistantEnabled: body.enabled };
  });

  // The embeddable messenger script. A site drops one <script src=".../widget.js" data-key="wk_…">
  // tag; the IIFE injects a shadow-DOM chat bubble + panel that talks to the public lanes above.
  // Served from the API so it has a stable, CORS-open origin. Long cache — it reads its config from
  // its own tag at runtime, so the same file serves every tenant.
  app.get("/widget.js", async (_req, reply) => {
    reply
      .header("content-type", "application/javascript; charset=utf-8")
      .header("cache-control", "public, max-age=300");
    return WIDGET_JS;
  });

  // The docs-site "Ask AI" embed (Wave 5 item 20) — same serving discipline as widget.js:
  // stable CORS-open origin, short cache, config read from its own script tag.
  app.get("/answers.js", async (_req, reply) => {
    reply
      .header("content-type", "application/javascript; charset=utf-8")
      .header("cache-control", "public, max-age=300");
    return ANSWERS_JS;
  });

  // Widget key management (authed, tenant-scoped). A tenant mints public keys for its embedded
  // widget, each with an optional domain allowlist; the key is shown in the list (public by design,
  // unlike a webhook secret).
  app.get("/widget-keys", tenanted(async (tenantId) => ({ keys: await listWidgetKeys(tenantId) })));

  app.post("/widget-keys", tenanted(async (tenantId, req, reply) => {
    const parsed = WidgetKeyInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const created = await createWidgetKey(tenantId, {
      label: parsed.data.label,
      allowedDomains: parsed.data.allowedDomains,
    });
    return reply.code(201).send({ key: created });
  }));

  // Update a key's label / domain allowlist / messenger personalization (Settings → Messenger).
  app.patch("/widget-keys/:key", tenanted(async (tenantId, req, reply) => {
    const parsed = WidgetKeyUpdateInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const updated = await updateWidgetKey(tenantId, (req.params as { key: string }).key, {
      label: parsed.data.label,
      allowedDomains: parsed.data.allowedDomains,
      config: parsed.data.config,
    });
    if (!updated) return reply.code(404).send({ error: "not found" });
    return { key: updated };
  }));

  app.delete("/widget-keys/:key", tenanted(async (tenantId, req, reply) => {
    const gone = await deleteWidgetKey(tenantId, (req.params as { key: string }).key);
    if (!gone) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  }));

  // Set (bring-your-own) or rotate a key's identity-verification secret. Pass { secret } to paste
  // an existing secret — e.g. your Intercom Identity Verification secret, so the user_hash your
  // backend already generates validates here with no code change (same HMAC-SHA256, same message).
  // Omit it to rotate to a fresh random secret. Every previously-issued hash then needs recomputing.
  app.post("/widget-keys/:key/identity-secret", tenanted(async (tenantId, req, reply) => {
    const body = (req.body ?? {}) as { secret?: string };
    if (body.secret !== undefined && (typeof body.secret !== "string" || body.secret.trim().length < 8)) {
      return reply.code(400).send({ error: "secret must be at least 8 characters" });
    }
    const updated = await setIdentitySecret(tenantId, (req.params as { key: string }).key, body.secret);
    if (!updated) return reply.code(404).send({ error: "not found" });
    return { key: updated };
  }));
}
