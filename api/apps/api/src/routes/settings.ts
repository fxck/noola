import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { authPool, withTenant } from "@repo/db";
import { putBuffer } from "../storage.js";
import {
  ModelConfigInput, AutoreplyPolicyInput, DiscordLinkInput, DiscordBotInput, EmailLinkInput, SlackConnectionInput,
  TranslationSettingsInput, TagRulesConfigInput, ClassificationConfigInput, DiscordMirrorConfigInput, DiscordChannelsConfigInput,
} from "@repo/contracts";
import { tenanted } from "../http/tenant.js";
import { getModelConfig, putModelConfig, testModelConfig } from "../modelconfig.js";
import { getAiOverview } from "../ai-overview.js";
import {
  getPolicy, putPolicy, listDecisionsForTicket, listQueue, sendQueued, dismissQueued,
  enqueueBacklog, drainJobs, listJobs,
} from "../autoreply.js";
import { patchTraceOutcome } from "../trace.js";
import {
  linkGuild, listDiscordChannelBindings, replaceDiscordChannelBindings,
  listDiscordChannelAccounts, setDiscordChannelAccount, unsetDiscordChannelAccount,
} from "../discord.js";
import { listBots, registerBot, deleteBot } from "../discord-bots.js";
import { setDiscordClassification, upsertAgentChannelIdentity } from "../discord-classify.js";
import { linkEmailRoute, handleInboundEmail, tenantSupportAddress } from "../email.js";
import {
  listSendingDomains, addSendingDomain, refreshSendingDomain, deleteSendingDomain,
  sendingProviderEnabled, SendingProviderError,
} from "../email-domains.js";
import { verifySlackSignature, handleSlackEvent, listSlackConnections, upsertSlackConnection, deleteSlackConnection, resolveTenantByTeam } from "../slack.js";
import { mdToSlack } from "../channels/format.js";
import {
  handleSlackAskCommand, handleSlackDraftCommand, slackPostDraft,
  stashSlackDraft, getSlackDraft, deleteSlackDraft,
} from "../slack-commands.js";
import {
  applySlackAction, handleSlackReaction, refreshSlackCard, recordSlackCsat, applyChannelAccount,
  setChannelAccount, unsetChannelAccount, listChannelAccounts, type SlackActionKind,
} from "../slack-triage.js";
import { searchTicketIds } from "../search.js";
import { hydrateTickets } from "../tickets.js";
import { getTranslationSettings, putTranslationSettings } from "../translate.js";
import { getTagConfig, replaceTagConfig } from "../tagrules.js";
import { getClassificationConfig, replaceClassificationConfig } from "../classification.js";
import { listMirrorBindings, replaceMirrorBindings, backfillMirrors } from "../discord-mirror.js";
import { getMirrorTransport } from "../discord-gateway.js";
import { relayPool } from "@repo/db";
import { BUILTIN_RISK_TAGS } from "../model.js";
import { channelCatalog } from "../channels/registry.js";
import { verifyWhatsAppChallenge, handleWhatsAppWebhook } from "../whatsapp.js";
import { listChannelConnections, saveChannelConnection, deleteChannelConnection, ChannelSecretsUnavailableError } from "../channel-connections.js";
import { getPolicies, putPolicies, ipAllowed, isInternalIp } from "../governance.js";
import { roleAtLeast } from "../rbac.js";

// Operational settings + inbound channels + ticket search: the BYO model config, the autoreply
// policy/queue/backlog, draft-trace outcomes, Discord/email/Slack channel connections, and the
// Typesense-backed ticket search. `/slack/events` is a public, HMAC-signed webhook (no session).
export default async function settingsRoutes(app: FastifyInstance): Promise<void> {
  // ---- AI governance overview (Wave 5 item 22) -----------------------------
  // The one aggregate behind the "AI" settings hub: model + persona + policy + queue +
  // last eval + 7-day activity, read-only (viewer+).
  app.get("/ai/overview", tenanted(async (tenantId) => ({ overview: await getAiOverview(tenantId) })));

  // ---- Settings: BYO per-tenant model config -------------------------------
  app.get("/settings/model", tenanted(async (tenantId) => getModelConfig(tenantId)));

  app.put("/settings/model", tenanted(async (tenantId, req, reply) => {
    const parsed = ModelConfigInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      return await putModelConfig(tenantId, parsed.data);
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode ?? 500;
      return reply.code(status).send({ error: (e as Error).message });
    }
  }));

  // Live reachability probe for the tenant's saved config (a tiny draft round-trip).
  app.post("/settings/model/test", tenanted(async (tenantId) => testModelConfig(tenantId)));

  // ---- Settings: translation (Wave 4) --------------------------------------
  // The workspace language + the auto-translate master switch. Detection + the language analytics
  // run regardless; this only governs whether foreign messages/replies get bridged through the model.
  app.get("/settings/translation", tenanted(async (tenantId) => getTranslationSettings(tenantId)));

  app.put("/settings/translation", tenanted(async (tenantId, req, reply) => {
    const parsed = TranslationSettingsInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return putTranslationSettings(tenantId, parsed.data);
  }));

  // ---- Settings: auto-tagging rules (STUDIO-SEEDED-FLOWS.md #1) -------------
  // The keyword→tag rules + AI toggle that project into the managed 'autotag' seed automations.
  // Reads install the built-in defaults on first access; writes full-replace + re-project.
  app.get("/settings/tag-rules", tenanted(async (tenantId) => getTagConfig(tenantId)));

  app.put("/settings/tag-rules", tenanted(async (tenantId, req, reply) => {
    const parsed = TagRulesConfigInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return replaceTagConfig(tenantId, parsed.data);
  }));

  // ---- Classification config (0087): topic rules + Slack reactions + additive risk keywords ----
  app.get("/settings/classification", tenanted(async (tenantId) => ({
    ...(await getClassificationConfig(tenantId)),
    builtinRiskTags: BUILTIN_RISK_TAGS,
  })));

  app.put("/settings/classification", tenanted(async (tenantId, req, reply) => {
    const parsed = ClassificationConfigInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return { ...(await replaceClassificationConfig(tenantId, parsed.data)), builtinRiskTags: BUILTIN_RISK_TAGS };
  }));

  // ---- Discord ops-mirror (0088): forum-mirror bindings + guild pickers -----
  // GET returns the bindings plus per-linked-guild forum/role lists (empty when the bot is offline —
  // the UI then falls back to manual ID entry). PUT is a full replace, same save model as
  // classification config.
  app.get("/settings/discord-mirror", tenanted(async (tenantId) => {
    const [bindings, links] = await Promise.all([
      listMirrorBindings(tenantId),
      relayPool.query("SELECT guild_id FROM discord_links WHERE tenant_id = $1", [tenantId]),
    ]);
    const tp = getMirrorTransport();
    const guilds = await Promise.all(
      (links.rows as { guild_id: string }[]).map(async ({ guild_id }) => ({
        id: guild_id,
        forums: tp ? await tp.listForums(guild_id).catch(() => []) : [],
        roles: tp ? await tp.listRoles(guild_id).catch(() => []) : [],
      })),
    );
    return { bindings, guilds, botOnline: !!tp };
  }));

  app.put("/settings/discord-mirror", tenanted(async (tenantId, req, reply) => {
    const parsed = DiscordMirrorConfigInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const bindings = await replaceMirrorBindings(tenantId, parsed.data.bindings);
    // Backfill the EXISTING open inbox into the saved bindings (fire-and-forget — posts appear
    // progressively; already-mirrored tickets skip, discord-origin never mirrors).
    void backfillMirrors(tenantId).catch(() => {});
    return { bindings };
  }));

  // ---- Discord customer channels (D5): VIP bindings + channel→company accounts
  // GET merges each binding with its account (company) row + per-guild channel pickers.
  // PUT full-replaces the tenant's bindings and syncs the account table from companyId.
  app.get("/settings/discord-channels", tenanted(async (tenantId) => {
    const [bindings, accounts, links] = await Promise.all([
      listDiscordChannelBindings(tenantId),
      listDiscordChannelAccounts(tenantId),
      relayPool.query("SELECT guild_id, team_role_ids FROM discord_links WHERE tenant_id = $1", [tenantId]),
    ]);
    const tp = getMirrorTransport();
    const guilds = await Promise.all(
      (links.rows as { guild_id: string; team_role_ids: unknown }[]).map(async ({ guild_id, team_role_ids }) => ({
        id: guild_id,
        // Identity classification: members with these roles are the tenant's own team — their
        // messages never mint tickets / never count as customers (the §9 seam, now UI-editable).
        teamRoleIds: Array.isArray(team_role_ids) ? (team_role_ids as string[]) : [],
        roles: tp ? await tp.listRoles(guild_id).catch(() => []) : [],
        // Text channels AND forums — a forum binding = community-forum intake (each post is
        // its own ticket via the thread=ticket path; the post author is the customer).
        channels: tp
          ? await Promise.all([
              tp.listTextChannels(guild_id).catch(() => []),
              tp.listForums(guild_id).catch(() => []),
            ]).then(([text, forums]) => [
              ...text.map((c) => ({ ...c, kind: "text" as const })),
              ...forums.map((c) => ({ ...c, kind: "forum" as const })),
            ])
          : [],
      })),
    );
    const byChannel = new Map(accounts.map((a) => [`${a.guild_id}:${a.channel_id}`, a]));
    return {
      bindings: bindings.map((b) => ({
        ...b,
        company_id: byChannel.get(`${b.guild_id}:${b.channel_id}`)?.company_id ?? null,
        company_name: byChannel.get(`${b.guild_id}:${b.channel_id}`)?.company_name ?? null,
      })),
      guilds,
      botOnline: !!tp,
    };
  }));

  app.put("/settings/discord-channels", tenanted(async (tenantId, req, reply) => {
    const parsed = DiscordChannelsConfigInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const bindings = await replaceDiscordChannelBindings(
      tenantId,
      parsed.data.bindings.map((b) => ({
        guildId: b.guildId, channelId: b.channelId, kind: b.kind, mode: b.mode,
        requireThread: b.requireThread, threadPerMessage: b.threadPerMessage,
        autoreplyMode: b.autoreplyMode ?? null,
      })),
    );
    // Sync the account bindings: set where a company is chosen, clear where it isn't.
    for (const b of parsed.data.bindings) {
      if (b.companyId) await setDiscordChannelAccount(tenantId, b.guildId, b.channelId, b.companyId);
      else await unsetDiscordChannelAccount(tenantId, b.guildId, b.channelId);
    }
    return { bindings };
  }));

  // ---- Channels: the outbound-driver catalog (connected vs available) -------
  app.get("/channels", tenanted(async (tenantId) => ({ channels: await channelCatalog(tenantId) })));

  // ---- Settings: Autoreply policy ------------------------------------------
  // off (assist only) | suggest_only (always draft, never send) | auto (confidence-gated auto-send).
  app.get("/autoreply/policy", tenanted(async (tenantId) => getPolicy(tenantId)));

  app.put("/autoreply/policy", tenanted(async (tenantId, req, reply) => {
    const parsed = AutoreplyPolicyInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return putPolicy(tenantId, parsed.data);
  }));

  // ---- Autoreply backlog jobs ----------------------------------------------
  // Enqueue the backlog + kick the drainer (fire-and-forget). No-op when mode is off.
  app.post("/autoreply/run", tenanted(async (tenantId) => {
    const policy = await getPolicy(tenantId);
    if (policy.mode === "off") {
      return { queued: 0, note: "autoreply mode is off — enable suggest_only or auto to run the backlog" };
    }
    const queued = await enqueueBacklog(tenantId);
    void drainJobs(tenantId).catch(() => {});
    return { queued };
  }));

  app.get("/autoreply/jobs", tenanted(async (tenantId) => listJobs(tenantId)));

  // ---- Autoreply approval queue --------------------------------------------
  // Drafts not auto-sent queue here for human review: Send / Edit+Send / Dismiss.
  app.get("/autoreply/queue", tenanted(async (tenantId) => ({ items: await listQueue(tenantId) })));

  app.post("/autoreply/queue/:id/send", tenanted(async (tenantId, req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body as { body?: string } | undefined)?.body;
    const out = await sendQueued(tenantId, id, body);
    if (!out.ok) return reply.code(out.code).send({ error: out.code === 404 ? "not found" : "not pending" });
    return { message: out.message };
  }));

  app.post("/autoreply/queue/:id/dismiss", tenanted(async (tenantId, req, reply) => {
    const { id } = req.params as { id: string };
    const out = await dismissQueued(tenantId, id);
    if (!out.ok) return reply.code(out.code).send({ error: out.code === 404 ? "not found" : "not pending" });
    return { ok: true };
  }));

  // The autoreply decision audit for a ticket (why a reply was auto-sent / held).
  app.get("/tickets/:id/autoreply", tenanted(async (tenantId, req) => ({
    decisions: await listDecisionsForTicket(tenantId, (req.params as { id: string }).id),
  })));

  // Back-fill the human verdict on a draft trace — the outcome signal the eval harness learns from.
  app.patch("/traces/:id/outcome", tenanted(async (tenantId, req, reply) => {
    const outcome = (req.body as { outcome?: string } | undefined)?.outcome ?? "";
    try {
      const ok = await patchTraceOutcome(tenantId, (req.params as { id: string }).id, outcome);
      if (!ok) return reply.code(404).send({ error: "trace not found" });
      return { ok: true };
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode ?? 500;
      return reply.code(status).send({ error: (e as Error).message });
    }
  }));

  // Channel onboarding: bind a Discord guild / support email address to the caller's OWN tenant
  // (from the session — a body tenantId is ignored so nobody can bind into another tenant).
  app.post("/discord/link", tenanted(async (tenantId, req, reply) => {
    const parsed = DiscordLinkInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    await linkGuild(parsed.data.guildId, tenantId);
    return reply.code(201).send({ ok: true, guildId: parsed.data.guildId, tenantId });
  }));

  // Phase 6 — per-tenant BYO Discord bots. List (token never returned), register (token encrypted +
  // verified against Discord), delete. A registered bot is DORMANT until the prod multibot gate is on;
  // the UI surfaces that. Tenant is the caller's own (a body tenantId can't cross tenants).
  app.get("/discord/bots", tenanted(async (tenantId) => ({ bots: await listBots(tenantId) })));

  app.post("/discord/bots", tenanted(async (tenantId, req, reply) => {
    const parsed = DiscordBotInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const bot = await registerBot(tenantId, parsed.data);
      return reply.code(201).send({ bot });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  }));

  app.delete("/discord/bots/:id", tenanted(async (tenantId, req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await deleteBot(tenantId, id);
    return reply.code(ok ? 200 : 404).send({ ok });
  }));

  // Phase 2 classification seam (§9): set a guild's role→identity mapping (team/community/ignore
  // roles + the default author kind). Body ids default to leaving each unset; tenant is the caller's
  // own (a body tenantId is ignored). Only affects the caller's own linked guild.
  app.post("/discord/classification", tenanted(async (tenantId, req, reply) => {
    const b = (req.body ?? {}) as {
      guildId?: unknown;
      teamRoleIds?: unknown;
      responderRoleIds?: unknown;
      ignoreRoleIds?: unknown;
      defaultAuthorKind?: unknown;
    };
    if (typeof b.guildId !== "string" || !b.guildId) return reply.code(400).send({ error: "guildId required" });
    const ids = (v: unknown): string[] | undefined =>
      Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
    const dk =
      b.defaultAuthorKind === "customer" || b.defaultAuthorKind === "community" || b.defaultAuthorKind === "agent"
        ? b.defaultAuthorKind
        : undefined;
    const ok = await setDiscordClassification(b.guildId, tenantId, {
      teamRoleIds: ids(b.teamRoleIds),
      responderRoleIds: ids(b.responderRoleIds),
      ignoreRoleIds: ids(b.ignoreRoleIds),
      defaultAuthorKind: dk,
    });
    if (!ok) return reply.code(404).send({ error: "no linked guild for this tenant" });
    return reply.send({ ok: true, guildId: b.guildId });
  }));

  // Phase 2 classification seam (§9): mark a Discord user id as a teammate → their Noola user seat,
  // so their inbound resolves to `author_type='agent'` with a real author_id (not a phantom contact).
  app.post("/discord/agent-identity", tenanted(async (tenantId, req, reply) => {
    const b = (req.body ?? {}) as { userId?: unknown; externalId?: unknown };
    if (typeof b.userId !== "string" || !b.userId) return reply.code(400).send({ error: "userId required" });
    if (typeof b.externalId !== "string" || !b.externalId) return reply.code(400).send({ error: "externalId required" });
    await upsertAgentChannelIdentity(tenantId, b.userId, b.externalId);
    return reply.code(201).send({ ok: true, userId: b.userId, externalId: b.externalId });
  }));

  // ---- Workspace identity (name + logo) ------------------------------------
  // better-auth's organization row is the authority (id == tenant uuid); the app-side tenants
  // projection mirrors the name. Logo rides the avatar keyspace (public GET /avatar/<uuid>.<ext>).
  // Workspace governance policies (0092): retention window, IP allowlist, 2FA requirement.
  app.get("/settings/policies", tenanted(async (tenantId) => getPolicies(tenantId)));

  app.put("/settings/policies", tenanted(async (tenantId, req, reply) => {
    if (!roleAtLeast(req.session?.role, "admin")) {
      return reply.code(403).send({ error: "admin role required" });
    }
    const b = (req.body ?? {}) as Partial<{ retentionDays: number | null; ipAllowlist: string[]; require2fa: boolean }>;
    const patch: { retentionDays?: number | null; ipAllowlist?: string[]; require2fa?: boolean } = {};
    if ("retentionDays" in b) {
      if (b.retentionDays !== null && (!Number.isInteger(b.retentionDays) || (b.retentionDays as number) < 7 || (b.retentionDays as number) > 3650)) {
        return reply.code(400).send({ error: "retentionDays must be 7–3650, or null to keep forever" });
      }
      patch.retentionDays = b.retentionDays ?? null;
    }
    if ("ipAllowlist" in b) {
      if (!Array.isArray(b.ipAllowlist) || b.ipAllowlist.length > 50) {
        return reply.code(400).send({ error: "ipAllowlist must be a list of up to 50 IPs/CIDRs" });
      }
      const list = b.ipAllowlist.map((s) => String(s).trim()).filter(Boolean);
      const bad = list.find((r) => !/^[0-9a-fA-F.:]+(\/\d{1,3})?$/.test(r));
      if (bad) return reply.code(400).send({ error: `'${bad}' is not an IP address or CIDR` });
      // Lock-out guard: never accept a list that would exclude the admin saving it (their
      // current IP must match, unless they're calling from infra-internal space).
      if (list.length && !isInternalIp(req.ip) && !ipAllowed(req.ip, list)) {
        return reply.code(400).send({ error: `this list would lock YOU out (your IP is ${req.ip}) — add it first` });
      }
      patch.ipAllowlist = list;
    }
    if ("require2fa" in b) patch.require2fa = Boolean(b.require2fa);
    return putPolicies(tenantId, patch);
  }));

  app.get("/settings/workspace", tenanted(async (tenantId) => {
    const r = await authPool.query(`SELECT name, logo FROM "organization" WHERE id = $1`, [tenantId]);
    return { name: r.rowCount ? (r.rows[0].name as string) : "", logoUrl: r.rowCount ? ((r.rows[0].logo as string | null) ?? null) : null };
  }));

  app.patch("/settings/workspace", tenanted(async (tenantId, req, reply) => {
    const b = (req.body ?? {}) as { name?: string; logo?: string | null };
    const name = typeof b.name === "string" ? b.name.trim() : undefined;
    if (name !== undefined && (name.length < 2 || name.length > 80)) {
      return reply.code(400).send({ error: "Workspace name must be 2–80 characters." });
    }
    if (name !== undefined) {
      await authPool.query(`UPDATE "organization" SET name = $2 WHERE id = $1`, [tenantId, name]);
      await withTenant(tenantId, async (c) => {
        await c.query("UPDATE tenants SET name = $1 WHERE id = current_tenant()", [name]);
      });
    }
    if (b.logo === null) {
      await authPool.query(`UPDATE "organization" SET logo = NULL WHERE id = $1`, [tenantId]);
    } else if (typeof b.logo === "string") {
      const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(b.logo);
      if (!m) return reply.code(400).send({ error: "logo must be a base64 image data URL" });
      const contentType = m[1].toLowerCase();
      const ext: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg" };
      if (!ext[contentType]) return reply.code(400).send({ error: "unsupported image type" });
      const bytes = Buffer.from(m[2], "base64");
      if (!bytes.byteLength || bytes.byteLength > 2 * 1024 * 1024) return reply.code(400).send({ error: "logo must be under 2MB" });
      const file = `${randomUUID()}.${ext[contentType]}`;
      await putBuffer(`avatars/${file}`, bytes, contentType);
      await authPool.query(`UPDATE "organization" SET logo = $2 WHERE id = $1`, [tenantId, `/avatar/${file}`]);
    }
    const r = await authPool.query(`SELECT name, logo FROM "organization" WHERE id = $1`, [tenantId]);
    return { name: (r.rows[0]?.name as string) ?? "", logoUrl: ((r.rows[0]?.logo as string | null) ?? null) };
  }));

  // The tenant's support/from address (outbound From for ticket replies). Read for the
  // Settings → Channels → Email editor; POST /email/link (below) sets it.
  app.get("/email/route", tenanted(async (tenantId) => ({ address: await tenantSupportAddress(tenantId) })));

  app.post("/email/link", tenanted(async (tenantId, req, reply) => {
    const parsed = EmailLinkInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    await linkEmailRoute(parsed.data.address, tenantId);
    return reply.code(201).send({ ok: true, address: parsed.data.address, tenantId });
  }));

  // ESP inbound webhook (PUBLIC lane, token-gated) — the PROD inbound email path. Point your
  // ESP's inbound-parse (Resend/Postmark/Mailgun/SES → a tiny adapter) here with the normalized
  // JSON shape; it rides the exact handleInboundEmail spine the dev Mailpit poller feeds, so
  // routing (per-ticket reply tokens, contact threading, idempotency by Message-ID) is identical.
  // Gate: EMAIL_INBOUND_TOKEN must be set (503 otherwise) and match ?token= or the
  // x-inbound-token header (401 otherwise).
  app.post("/email/inbound", async (req, reply) => {
    const expect = process.env.EMAIL_INBOUND_TOKEN;
    if (!expect) return reply.code(503).send({ error: "inbound email webhook disabled — EMAIL_INBOUND_TOKEN not set" });
    const got = (req.query as { token?: string } | undefined)?.token ?? req.headers["x-inbound-token"];
    if (got !== expect) return reply.code(401).send({ error: "bad inbound token" });
    const b = (req.body ?? {}) as Partial<{
      messageId: string; from: string; fromName: string; to: string; subject: string; body: string;
      cc: string[];
      attachments: { filename?: string; contentType?: string; dataBase64?: string }[];
    }>;
    if (!b.messageId || !b.from || !b.to) {
      return reply.code(400).send({ error: "messageId, from, to are required (normalized inbound shape)" });
    }
    // Adapter-normalized attachments arrive base64-inline (ESP inbound-parse payloads are inline
    // too); same 10-file / 10MB-per-file ceiling as the Mailpit poller.
    const files = (Array.isArray(b.attachments) ? b.attachments : []).slice(0, 10).flatMap((a) => {
      if (!a?.dataBase64) return [];
      try {
        const data = Buffer.from(a.dataBase64, "base64");
        if (!data.byteLength || data.byteLength > 10 * 1024 * 1024) return [];
        return [{ filename: a.filename || "file", contentType: a.contentType || "application/octet-stream", data }];
      } catch { return []; }
    });
    const cc = (Array.isArray(b.cc) ? b.cc : []).map((a) => String(a).toLowerCase()).filter(Boolean).slice(0, 10);
    const result = await handleInboundEmail({
      messageId: b.messageId, from: b.from, fromName: b.fromName, to: b.to,
      subject: b.subject ?? "", body: b.body ?? "",
      ...(cc.length ? { cc } : {}), ...(files.length ? { attachments: files } : {}),
    });
    // null = the recipient maps to no tenant route (or our own echo) — accepted, not ingested.
    return reply.code(result ? 201 : 202).send({ ok: true, ingested: !!result, ticketId: result?.ticketId ?? null });
  });

  // ---- Model-B: branded sending domains (Intercom "custom email domain") ----
  // A tenant verifies their OWN domain (e.g. zerops.io) so replies send AS support@theirdomain with
  // real DKIM. GET lists them + whether self-serve provisioning is on (RESEND_API_KEY set); POST
  // adds one (creating the provider domain object + returning the DNS records to publish); verify
  // re-checks; DELETE removes. Governs OUTBOUND identity only — inbound routing stays in email_routes.
  app.get("/email/domains", tenanted(async (tenantId) => ({
    domains: await listSendingDomains(tenantId),
    providerEnabled: sendingProviderEnabled(),
  })));

  app.post("/email/domains", tenanted(async (tenantId, req, reply) => {
    const domain = String((req.body as { domain?: string } | undefined)?.domain ?? "").trim().toLowerCase();
    if (!/^(?=.{1,253}$)([a-z0-9](-?[a-z0-9])*\.)+[a-z]{2,}$/.test(domain)) {
      return reply.code(400).send({ error: "Enter a valid domain like zerops.io (no https://, no path)." });
    }
    try {
      const d = await addSendingDomain(tenantId, domain);
      return reply.code(201).send({ domain: d });
    } catch (e) {
      if ((e as { code?: string }).code === "23505") {
        return reply.code(409).send({ error: "That domain is already added." });
      }
      if (e instanceof SendingProviderError) return reply.code(502).send({ error: e.message });
      throw e;
    }
  }));

  app.post("/email/domains/:id/verify", tenanted(async (tenantId, req, reply) => {
    try {
      const d = await refreshSendingDomain(tenantId, (req.params as { id: string }).id);
      if (!d) return reply.code(404).send({ error: "not found" });
      return { domain: d };
    } catch (e) {
      if (e instanceof SendingProviderError) return reply.code(502).send({ error: e.message });
      throw e;
    }
  }));

  app.delete("/email/domains/:id", tenanted(async (tenantId, req, reply) => {
    try {
      const gone = await deleteSendingDomain(tenantId, (req.params as { id: string }).id);
      if (!gone) return reply.code(404).send({ error: "not found" });
      return { ok: true };
    } catch (e) {
      if (e instanceof SendingProviderError) return reply.code(502).send({ error: e.message });
      throw e;
    }
  }));

  // ---- Slack channel --------------------------------------------------------
  // The Slack Events API entrypoint (PUBLIC lane). Slack signs the RAW body (v0 HMAC-SHA256); we
  // re-hash req.rawBody to verify. url_verification returns the challenge; every other event is
  // signature-gated then handled fire-and-forget so Slack gets a fast 200.
  app.post("/slack/events", async (req, reply) => {
    const raw = (req as { rawBody?: string }).rawBody ?? "";
    const body = req.body as { type?: string; challenge?: string } | undefined;
    if (body?.type === "url_verification") {
      return reply.code(200).send({ challenge: body.challenge ?? "" });
    }
    const timestamp = req.headers["x-slack-request-timestamp"];
    const signature = req.headers["x-slack-signature"];
    if (
      !verifySlackSignature(
        raw,
        typeof timestamp === "string" ? timestamp : undefined,
        typeof signature === "string" ? signature : undefined,
      )
    ) {
      return reply.code(401).send({ error: "bad signature" });
    }
    // Fire-and-forget so Slack gets a fast 200; triage side-effects (status card, account roll-up,
    // emoji-reaction triage) run after on the parsed result — none of them block the ack.
    void handleSlackEvent(raw)
      .then(async (res) => {
        if (res.kind === "ingested" && res.result.tenantId) {
          await applyChannelAccount(res.result.tenantId, res.teamId, res.channel, res.result.contactId).catch(() => {});
          await refreshSlackCard(res.result.tenantId, res.teamId, res.channel, res.result.ticketId).catch(() => {});
        } else if (res.kind === "reaction") {
          await handleSlackReaction(res.teamId, res.channel, res.reaction, res.userId).catch(() => {});
        }
      })
      .catch((err) => app.log.error({ err }, "slack inbound ingest failed"));
    return reply.code(200).send({ ok: true });
  });

  // ---- Slack on-demand /ask + /draft (public, signature-gated) ----------------
  // Slack slash commands + interactivity are form-encoded + signed. Both must ACK within 3s, so the
  // RAG work runs async and the result is delivered to the invocation's `response_url` (a short-lived
  // webhook — no bot token needed for /ask). The /draft Post button rides the interactivity endpoint.
  const slackSigOk = (req: { rawBody?: string; headers: Record<string, unknown> }): boolean =>
    verifySlackSignature(
      req.rawBody ?? "",
      typeof req.headers["x-slack-request-timestamp"] === "string" ? (req.headers["x-slack-request-timestamp"] as string) : undefined,
      typeof req.headers["x-slack-signature"] === "string" ? (req.headers["x-slack-signature"] as string) : undefined,
    );

  // POST JSON to a Slack response_url (5s timeout, best-effort). response_url is an unauthenticated
  // short-lived webhook Slack hands us per invocation — how a deferred slash reply is delivered.
  const postResponse = async (url: string, payload: unknown): Promise<void> => {
    if (!url) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    try {
      await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: ctrl.signal });
    } catch {
      /* best-effort */
    } finally {
      clearTimeout(t);
    }
  };

  // The ephemeral /draft preview + its "Post to channel" button (Block Kit).
  const draftBlocks = (text: string, token: string): unknown[] => [
    { type: "section", text: { type: "mrkdwn", text: mdToSlack(text).slice(0, 2900) } },
    { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Post to channel" }, style: "primary", action_id: "slack_post_draft", value: token }] },
  ];

  app.post("/slack/commands", async (req, reply) => {
    if (!slackSigOk(req as { rawBody?: string; headers: Record<string, unknown> })) return reply.code(401).send({ error: "bad signature" });
    const b = (req.body ?? {}) as Record<string, string>;
    const command = b.command ?? "";
    const text = b.text ?? "";
    const teamId = b.team_id ?? "";
    const channelId = b.channel_id ?? "";
    const userId = b.user_id ?? "";
    const responseUrl = b.response_url ?? "";
    const triggerId = b.trigger_id ?? `${teamId}:${channelId}:${b.ts ?? ""}`;

    // Async worker — the ack below returns first (within Slack's 3s window).
    void (async () => {
      if (command === "/ask") {
        const res = await handleSlackAskCommand({ teamId, channelId, userId, text, triggerId });
        if (res.status === "answered" && res.text) {
          await postResponse(responseUrl, { response_type: "in_channel", text: mdToSlack(res.text) });
        } else {
          const notice =
            res.status === "held" ? (res.text ?? "A teammate will follow up.")
            : res.status === "not_connected" ? "This workspace isn't connected to the assistant."
            : res.status === "empty" ? "Please include a question."
            : "Something went wrong.";
          await postResponse(responseUrl, { response_type: "ephemeral", replace_original: true, text: notice });
        }
      } else if (command === "/draft") {
        const res = await handleSlackDraftCommand({ teamId, channelId, text });
        if (res.status === "drafted" && res.text && res.ticketId) {
          const token = stashSlackDraft({ teamId, channelId, ticketId: res.ticketId, text: res.text });
          await postResponse(responseUrl, { response_type: "ephemeral", blocks: draftBlocks(res.text, token) });
        } else {
          const notice =
            res.status === "no_ticket" ? "No open ticket in this channel yet — reply in the channel first."
            : res.status === "not_connected" ? "This workspace isn't connected to the assistant."
            : res.status === "empty" ? "Please include what the reply should address."
            : "Something went wrong.";
          await postResponse(responseUrl, { response_type: "ephemeral", replace_original: true, text: notice });
        }
      } else if (command === "/note") {
        // Team-only internal note on the channel's ticket (never posted to the customer).
        const res = await applySlackAction({ teamId, channelId, actorId: userId, actorName: b.user_name ?? null, kind: "note", value: text });
        await postResponse(responseUrl, { response_type: "ephemeral", replace_original: true, text: res.message });
      }
    })().catch((err) => app.log.error({ err }, "slack command failed"));

    // Fast ephemeral ack (only the invoker sees it) — replaced by the async result above.
    return reply.code(200).send({ response_type: "ephemeral", text: command === "/draft" ? "Drafting…" : "On it…" });
  });

  // Map a card/message-action button action_id → a triage action kind.
  const TRIAGE_ACTIONS: Record<string, SlackActionKind> = {
    triage_close: "close",
    triage_reopen: "reopen",
    triage_snooze: "snooze",
    triage_priority: "priority",
    triage_assign_me: "assign_me",
    triage_unassign: "unassign",
  };

  app.post("/slack/interactions", async (req, reply) => {
    if (!slackSigOk(req as { rawBody?: string; headers: Record<string, unknown> })) return reply.code(401).send({ error: "bad signature" });
    const b = (req.body ?? {}) as Record<string, string>;
    let payload: {
      type?: string;
      team?: { id?: string };
      channel?: { id?: string };
      user?: { id?: string; name?: string };
      actions?: { action_id?: string; value?: string }[];
      response_url?: string;
    };
    try {
      payload = JSON.parse(b.payload ?? "{}");
    } catch {
      return reply.code(400).send({ error: "bad payload" });
    }
    const action = payload.actions?.[0];
    const teamId = payload.team?.id ?? "";
    const channelId = payload.channel?.id ?? "";
    const userId = payload.user?.id ?? "";
    const ack = (text: string) => postResponse(payload.response_url ?? "", { response_type: "ephemeral", text });

    // /draft → Post relay (existing).
    if (action?.action_id === "slack_post_draft" && action.value) {
      const token = action.value;
      const draft = getSlackDraft(token);
      if (!draft) {
        void postResponse(payload.response_url ?? "", { replace_original: true, text: "This draft expired — run /draft again." });
        return reply.code(200).send();
      }
      void (async () => {
        const r = await slackPostDraft({ teamId: draft.teamId, channelId: draft.channelId, ticketId: draft.ticketId, text: draft.text, postId: token });
        deleteSlackDraft(token);
        await postResponse(payload.response_url ?? "", {
          replace_original: true,
          text: r.delivered ? "✅ Posted to the channel." : "Couldn't post — the workspace may be disconnected.",
        });
      })().catch((err) => app.log.error({ err }, "slack interaction failed"));
      return reply.code(200).send();
    }

    // Ticket-card triage buttons (assign / snooze / priority / close / reopen).
    if (action?.action_id && TRIAGE_ACTIONS[action.action_id]) {
      const kind = TRIAGE_ACTIONS[action.action_id];
      void (async () => {
        const res = await applySlackAction({ teamId, channelId, actorId: userId, actorName: payload.user?.name ?? null, kind, value: action.value });
        await ack(res.message);
      })().catch((err) => app.log.error({ err }, "slack triage action failed"));
      return reply.code(200).send();
    }

    // CSAT rating button (value = "<ticketId>:<rating>").
    if (action?.action_id === "csat_rate" && action.value) {
      const [ticketId, ratingStr] = action.value.split(":");
      const rating = Number(ratingStr);
      void (async () => {
        const tenantId = await resolveTenantByTeam(teamId);
        if (tenantId && ticketId && rating >= 1 && rating <= 5) {
          await recordSlackCsat(tenantId, ticketId, rating);
          await postResponse(payload.response_url ?? "", { replace_original: true, text: `Thanks for the feedback — you rated us ${rating}★.` });
        }
      })().catch((err) => app.log.error({ err }, "slack csat failed"));
      return reply.code(200).send();
    }

    return reply.code(200).send();
  });

  // ---- WhatsApp channel (Wave 4) --------------------------------------------
  // Meta Cloud API webhook (PUBLIC lane). GET is the subscription handshake (echo hub.challenge when
  // the verify token matches); POST delivers inbound messages, funneled fire-and-forget through the
  // shared ingest core so Meta gets a fast 200. Creds-gated — a no-op until WHATSAPP_* is set.
  app.get("/whatsapp/webhook", async (req, reply) => {
    const challenge = await verifyWhatsAppChallenge(req.query as Record<string, unknown>);
    if (challenge === null) return reply.code(403).send({ error: "verification failed" });
    return reply.header("content-type", "text/plain").send(challenge);
  });

  app.post("/whatsapp/webhook", async (req, reply) => {
    void handleWhatsAppWebhook(req.body as Parameters<typeof handleWhatsAppWebhook>[0]).catch((err) =>
      app.log.error({ err }, "whatsapp inbound ingest failed"),
    );
    return reply.code(200).send({ ok: true });
  });

  // Self-serve channel connections (0092): per-tenant Telegram/WhatsApp credentials. Secrets
  // are write-only — the row exposes hasSecret, never the value. Save replaces the channel's
  // existing connection; admin-gated like the rest of the channel config surface.
  app.get("/channel-connections", tenanted(async (tenantId) => ({
    connections: await listChannelConnections(tenantId),
  })));

  app.post("/channel-connections", tenanted(async (tenantId, req, reply) => {
    const b = (req.body ?? {}) as Partial<{
      channel: string; label: string;
      botToken: string;                      // telegram
      token: string; phoneId: string; verifyToken: string;  // whatsapp
    }>;
    if (b.channel !== "telegram" && b.channel !== "whatsapp") {
      return reply.code(400).send({ error: "channel must be 'telegram' or 'whatsapp'" });
    }
    let input: { channel: "telegram" | "whatsapp"; label?: string; config?: Record<string, unknown>; secret: Record<string, string> };
    if (b.channel === "telegram") {
      if (!b.botToken?.trim()) return reply.code(400).send({ error: "botToken is required" });
      input = { channel: "telegram", label: b.label ?? "", secret: { botToken: b.botToken.trim() } };
    } else {
      if (!b.token?.trim() || !b.phoneId?.trim()) return reply.code(400).send({ error: "token and phoneId are required" });
      input = {
        channel: "whatsapp", label: b.label ?? "",
        config: { phoneId: b.phoneId.trim() },
        secret: { token: b.token.trim(), ...(b.verifyToken?.trim() ? { verifyToken: b.verifyToken.trim() } : {}) },
      };
    }
    try {
      const connection = await saveChannelConnection(tenantId, input);
      return reply.code(201).send({ connection });
    } catch (e) {
      if (e instanceof ChannelSecretsUnavailableError) return reply.code(503).send({ error: e.message });
      // Another tenant already owns this WhatsApp number (global phoneId unique → RLS-invisible row).
      if ((e as { code?: string }).code === "23505") return reply.code(409).send({ error: "this phone number ID is already connected to another workspace" });
      throw e;
    }
  }));

  app.delete("/channel-connections/:id", tenanted(async (tenantId, req, reply) => {
    const gone = await deleteChannelConnection(tenantId, (req.params as { id: string }).id);
    if (!gone) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  }));

  // Slack workspace→tenant connections (onboarding). GET masks the bot token; POST upserts
  // (idempotent on team_id); DELETE removes by id.
  app.get("/slack/connections", tenanted(async (tenantId) => ({ connections: await listSlackConnections(tenantId) })));

  app.post("/slack/connections", tenanted(async (tenantId, req, reply) => {
    const parsed = SlackConnectionInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const connection = await upsertSlackConnection(tenantId, parsed.data);
      return reply.code(201).send({ connection });
    } catch (e) {
      // A workspace maps to exactly one tenant (global unique team_id); a second tenant claiming it
      // hits an ON CONFLICT whose DO UPDATE targets the owning tenant's (RLS-invisible) row → 42501.
      if ((e as { code?: string }).code === "42501") {
        return reply.code(409).send({ error: "workspace already connected to another tenant" });
      }
      throw e;
    }
  }));

  app.delete("/slack/connections/:id", tenanted(async (tenantId, req, reply) => {
    const gone = await deleteSlackConnection(tenantId, (req.params as { id: string }).id);
    if (!gone) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  }));

  // Slack channel → account binding: conversations in a bound channel roll up to a customer company
  // (the channel's contacts inherit it). List / set (team_id + channel + company_id) / unset.
  app.get("/slack/channel-accounts", tenanted(async (tenantId) => ({ bindings: await listChannelAccounts(tenantId) })));

  app.post("/slack/channel-accounts", tenanted(async (tenantId, req, reply) => {
    const b = (req.body ?? {}) as { teamId?: string; channel?: string; companyId?: string };
    if (!b.teamId || !b.channel || !b.companyId) return reply.code(400).send({ error: "teamId, channel, companyId required" });
    try {
      await setChannelAccount(tenantId, b.teamId, b.channel, b.companyId);
      return reply.code(201).send({ ok: true });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  }));

  app.delete("/slack/channel-accounts", tenanted(async (tenantId, req, reply) => {
    const q = req.query as { teamId?: string; channel?: string };
    if (!q.teamId || !q.channel) return reply.code(400).send({ error: "teamId + channel required" });
    const gone = await unsetChannelAccount(tenantId, q.teamId, q.channel);
    return reply.code(gone ? 200 : 404).send({ ok: gone });
  }));

  // Tenant-scoped ticket search: Typesense ranks the full-text hits, then rows hydrate through RLS
  // — same shape as /tickets. Double tenant guard: index filter_by + RLS.
  app.get("/search", tenanted(async (tenantId, req, reply) => {
    const q = (req.query as { q?: string } | undefined)?.q ?? "";
    try {
      const ids = await searchTicketIds(tenantId, q);
      return { tickets: await hydrateTickets(tenantId, ids) };
    } catch (err) {
      app.log.error({ err }, "search failed");
      return reply.code(502).send({ error: "search unavailable" });
    }
  }));
}
