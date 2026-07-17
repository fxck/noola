import type { FastifyInstance } from "fastify";
import { WebhookInput, BroadcastInput, BroadcastPatch, BroadcastBlocks, EmailTemplateInput, EmailTemplateTokens } from "@repo/contracts";
import { applyMergeTags, SAMPLE_MERGE_DATA } from "../merge-tags.js";
import { sendOutboundEmail } from "../email.js";
import { tenanted } from "../http/tenant.js";
import { mdToSlack, mdToTelegramHtml, mdToWhatsApp, mdToPlain } from "../channels/format.js";
import { listWebhooks, createWebhook, updateWebhook, deleteWebhook, sendTestPing, listDeliveries } from "../webhooks.js";
import {
  previewSegment,
  createBroadcast,
  listBroadcasts,
  getBroadcast,
  sendBroadcast,
  cancelBroadcast,
  InvalidChannelError,
  InvalidTemplateError,
  InvalidScheduleError,
  MissingTargetError,
  updateBroadcast, NotDraftError, mdFromBlocks,
} from "../broadcasts.js";
import {
  listTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  isBuiltinTemplate,
  resolveTemplateTokens,
  mergeTokens,
} from "../email-templates.js";
import { renderBroadcastEmail } from "../emails/broadcast-email.js";

// Outbound messaging: subscriber webhooks (HMAC-signed event delivery + attempt log),
// broadcasts (mass-send a filtered contact segment over ONE channel — email via the
// outbound-email seam, chat channels via the channel-registry drivers), and the email
// template designer (per-tenant design tokens + server-rendered live preview).
export default async function outboundRoutes(app: FastifyInstance): Promise<void> {
  // ---- Outbound webhooks ---------------------------------------------------
  // A tenant subscribes webhook URLs to events; a fired event POSTs an HMAC-signed payload and
  // records each attempt. The signing secret is shown ONCE on create (has_secret flag after).
  app.get("/webhooks", tenanted(async (tenantId) => ({ webhooks: await listWebhooks(tenantId) })));

  app.post("/webhooks", tenanted(async (tenantId, req, reply) => {
    const parsed = WebhookInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { webhook, secret } = await createWebhook(tenantId, parsed.data);
    return reply.code(201).send({ webhook, secret }); // secret shown exactly once
  }));

  app.patch("/webhooks/:id", tenanted(async (tenantId, req, reply) => {
    const parsed = WebhookInput.partial().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const webhook = await updateWebhook(tenantId, (req.params as { id: string }).id, parsed.data);
    if (!webhook) return reply.code(404).send({ error: "not found" });
    return { webhook };
  }));

  app.delete("/webhooks/:id", tenanted(async (tenantId, req, reply) => {
    const gone = await deleteWebhook(tenantId, (req.params as { id: string }).id);
    if (!gone) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  }));

  // Fire a synthetic 'ping' to one webhook and return the delivery result synchronously.
  app.post("/webhooks/:id/test", tenanted(async (tenantId, req, reply) => {
    const delivery = await sendTestPing(tenantId, (req.params as { id: string }).id);
    if (!delivery) return reply.code(404).send({ error: "not found" });
    return { delivery };
  }));

  app.get("/webhooks/:id/deliveries", tenanted(async (tenantId, req) => {
    const limit = Number((req.query as { limit?: string } | undefined)?.limit) || 20;
    return { deliveries: await listDeliveries(tenantId, (req.params as { id: string }).id, limit) };
  }));

  // ---- Broadcast -----------------------------------------------------------
  // Compose a subject+body, target a filtered contacts segment, pick ONE channel, and
  // mass-send through that channel's driver (email → Mailpit in dev, chat channels →
  // registry dispatch). POST /:id/send kicks the send in the background.
  app.get("/broadcasts", tenanted(async (tenantId) => ({ broadcasts: await listBroadcasts(tenantId) })));

  // Preview a segment before composing: how many contacts match + per-channel reachable
  // handle counts → { total, reachable: { email: n, discord: n, … } }.
  app.post("/broadcasts/preview", tenanted(async (tenantId, req) => {
    const segment = ((req.body as { segment?: Record<string, unknown> } | undefined)?.segment) ?? {};
    return previewSegment(tenantId, segment);
  }));

  app.post("/broadcasts", tenanted(async (tenantId, req, reply) => {
    const parsed = BroadcastInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const broadcast = await createBroadcast(tenantId, parsed.data);
      return reply.code(201).send({ broadcast });
    } catch (e) {
      // A bad channel, templateId, or schedule datetime is a caller mistake, not a 500.
      if (
        e instanceof InvalidChannelError ||
        e instanceof InvalidTemplateError ||
        e instanceof InvalidScheduleError ||
        e instanceof MissingTargetError
      ) {
        return reply.code(400).send({ error: e.message });
      }
      throw e;
    }
  }));

  // Draft-only edit (0072): re-open a draft in the composer, change anything, save. Non-draft
  // targets 409 (cancel a scheduled one back to draft first).
  app.patch("/broadcasts/:id", tenanted(async (tenantId, req, reply) => {
    const parsed = BroadcastPatch.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const broadcast = await updateBroadcast(tenantId, (req.params as { id: string }).id, parsed.data);
      if (!broadcast) return reply.code(404).send({ error: "not found" });
      return { broadcast };
    } catch (e) {
      if (e instanceof NotDraftError) return reply.code(409).send({ error: e.message });
      if (
        e instanceof InvalidChannelError ||
        e instanceof InvalidTemplateError ||
        e instanceof InvalidScheduleError ||
        e instanceof MissingTargetError
      ) {
        return reply.code(400).send({ error: e.message });
      }
      throw e;
    }
  }));

  // Kick the send. Depending on the draft's delivery settings this returns 'sending' (mass
  // send running now), 'scheduled' (armed; the worker fires it at send_at), or 'active'
  // (continuous; the worker sends to first-time matchers each tick). 409 for terminal states.
  app.post("/broadcasts/:id/send", tenanted(async (tenantId, req, reply) => {
    const out = await sendBroadcast(tenantId, (req.params as { id: string }).id);
    if (!out) return reply.code(404).send({ error: "not found" });
    if (out.status !== "sending" && out.status !== "scheduled" && out.status !== "active") {
      return reply.code(409).send({ error: `broadcast is '${out.status}', not sendable`, status: out.status });
    }
    return { status: out.status };
  }));

  // Walk back an armed broadcast: 'scheduled' → 'draft', 'active' (continuous) → 'stopped'.
  app.post("/broadcasts/:id/cancel", tenanted(async (tenantId, req, reply) => {
    const out = await cancelBroadcast(tenantId, (req.params as { id: string }).id);
    if (!out) return reply.code(404).send({ error: "not found" });
    if (out.status !== "draft" && out.status !== "stopped") {
      return reply.code(409).send({ error: `broadcast is '${out.status}' — nothing to cancel`, status: out.status });
    }
    return { status: out.status };
  }));

  app.get("/broadcasts/:id", tenanted(async (tenantId, req, reply) => {
    const out = await getBroadcast(tenantId, (req.params as { id: string }).id);
    if (!out) return reply.code(404).send({ error: "not found" });
    return { broadcast: out.broadcast, recipients: out.recipients, stats: out.stats };
  }));

  // The composer's live preview: render draft content (markdown body OR block list) through
  // EXACTLY the send-path renderer, with merge tags substituted against a sample recipient
  // so the preview reads real. Returns full HTML for an <iframe srcDoc>.
  app.post("/broadcasts/preview-render", tenanted(async (tenantId, req, reply) => {
    const b = (req.body ?? {}) as { subject?: string; body?: string; blocks?: unknown; templateId?: string };
    let blocks = undefined;
    if (b.blocks !== undefined) {
      const parsed = BroadcastBlocks.safeParse(b.blocks);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      blocks = parsed.data;
    }
    const subject = typeof b.subject === "string" ? b.subject.slice(0, 500) : "";
    const body = typeof b.body === "string" ? b.body.slice(0, 100000) : "";
    const tokens = await resolveTemplateTokens(tenantId, b.templateId ?? "branded");
    const { html, text } = await renderBroadcastEmail(subject, body, {
      tokens,
      ...(blocks ? { blocks } : {}),
      unsubscribeHref: "https://example.com/unsubscribe-preview",
    });
    // Per-channel chat previews (0072): the DERIVED markdown body (blocks flatten to md) run
    // through the real driver-seam transforms, so the composer can show exactly what each
    // chat channel receives. Merge tags substituted with the same sample recipient.
    const chatMd = applyMergeTags(blocks ? mdFromBlocks(blocks) : body, SAMPLE_MERGE_DATA);
    return {
      html: applyMergeTags(html, SAMPLE_MERGE_DATA, { html: true }),
      text: applyMergeTags(text, SAMPLE_MERGE_DATA),
      subject: applyMergeTags(subject, SAMPLE_MERGE_DATA),
      chat: {
        markdown: chatMd,
        discord: chatMd,
        slack: mdToSlack(chatMd),
        telegram: mdToTelegramHtml(chatMd),
        whatsapp: mdToWhatsApp(chatMd),
        plain: mdToPlain(chatMd),
      },
    };
  }));

  // "Send a test to me": one rendered email to the signed-in agent's own address, sample
  // merge data, no recipient logging, no draft required. Email channel only by design.
  app.post("/broadcasts/test", tenanted(async (tenantId, req, reply) => {
    const to = req.session?.email;
    if (!to) return reply.code(400).send({ error: "your session has no email address to send to" });
    const b = (req.body ?? {}) as { subject?: string; body?: string; blocks?: unknown; templateId?: string };
    if (!b.subject || typeof b.subject !== "string") return reply.code(400).send({ error: "subject is required" });
    let blocks = undefined;
    if (b.blocks !== undefined) {
      const parsed = BroadcastBlocks.safeParse(b.blocks);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      blocks = parsed.data;
    }
    const body = typeof b.body === "string" ? b.body.slice(0, 100000) : "";
    const tokens = await resolveTemplateTokens(tenantId, b.templateId ?? "branded");
    const rendered = await renderBroadcastEmail(b.subject.slice(0, 500), body, {
      tokens,
      ...(blocks ? { blocks } : {}),
    }).catch(() => null);
    const subject = `[Test] ${applyMergeTags(b.subject.slice(0, 500), SAMPLE_MERGE_DATA)}`;
    const out = await sendOutboundEmail(
      tenantId,
      to,
      subject,
      applyMergeTags(rendered?.text || body, SAMPLE_MERGE_DATA),
      rendered ? { html: applyMergeTags(rendered.html, SAMPLE_MERGE_DATA, { html: true }) } : undefined,
    );
    if (!out.delivered) return reply.code(502).send({ error: out.reason ?? "not delivered" });
    return { delivered: true, to };
  }));

  // ---- Email template designer ----------------------------------------------
  // Design tokens that parameterize the react.email frame. Built-ins ('branded', 'personal')
  // come from code and are read-only; custom templates are tenant rows.
  app.get("/email-templates", tenanted(async (tenantId) => ({ templates: await listTemplates(tenantId) })));

  app.post("/email-templates", tenanted(async (tenantId, req, reply) => {
    const parsed = EmailTemplateInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const template = await createTemplate(tenantId, parsed.data);
    return reply.code(201).send({ template });
  }));

  app.patch("/email-templates/:id", tenanted(async (tenantId, req, reply) => {
    const id = (req.params as { id: string }).id;
    if (isBuiltinTemplate(id)) {
      return reply.code(400).send({ error: "built-in templates are read-only — save a copy instead" });
    }
    const parsed = EmailTemplateInput.partial().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const template = await updateTemplate(tenantId, id, parsed.data);
    if (!template) return reply.code(404).send({ error: "not found" });
    return { template };
  }));

  app.delete("/email-templates/:id", tenanted(async (tenantId, req, reply) => {
    const id = (req.params as { id: string }).id;
    if (isBuiltinTemplate(id)) return reply.code(400).send({ error: "built-in templates cannot be deleted" });
    const gone = await deleteTemplate(tenantId, id);
    if (!gone) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  }));

  // The designer's live preview: render sample (or supplied) content through EXACTLY the
  // send-path renderer. Pass `tokens` for unsaved designer state, or `templateId` to preview
  // a saved/built-in template as-is. Returns full HTML for an <iframe srcDoc>.
  app.post("/email-templates/preview", tenanted(async (tenantId, req, reply) => {
    const b = (req.body ?? {}) as { tokens?: unknown; templateId?: string; subject?: string; body?: string };
    const parsedTokens = EmailTemplateTokens.safeParse(b.tokens ?? {});
    if (b.tokens !== undefined && !parsedTokens.success) {
      return reply.code(400).send({ error: parsedTokens.error.flatten() });
    }
    const tokens =
      b.tokens !== undefined
        ? mergeTokens(parsedTokens.success ? parsedTokens.data : {})
        : await resolveTemplateTokens(tenantId, b.templateId ?? "branded");
    const subject = typeof b.subject === "string" && b.subject ? b.subject.slice(0, 500) : "A message from your team";
    const body =
      typeof b.body === "string" && b.body
        ? b.body.slice(0, 10000)
        : "Hi there,\n\nThis is what your emails will look like. **Bold**, _italic_, and [links](https://example.com) pick up your template's styling.\n\n- Product updates\n- Onboarding tips\n\nThanks for reading!";
    const { html, text } = await renderBroadcastEmail(subject, body, {
      tokens,
      unsubscribeHref: "https://example.com/unsubscribe-preview",
    });
    return { html, text };
  }));
}
