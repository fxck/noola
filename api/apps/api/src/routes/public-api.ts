import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { PublicAnswerInput, PublicTicketInput, CsatInput, NpsInput, ApiKeyInput, PublicEventInput } from "@repo/contracts";
import { tenanted } from "../http/tenant.js";
import { rateLimit } from "../ratelimit.js";
import { resolveApiKey, listApiKeys, createApiKey, revokeApiKey } from "../apikeys.js";
import { suggestForQuery } from "../copilot.js";
import { ingestInbound } from "../ingest.js";
import { trackEvent } from "../contact-events.js";
import { queryTickets } from "../tickets.js";
import { recordCsat } from "../csat.js";
import { recordNps } from "../nps.js";
import { emitDomainEvent } from "../automations.js";
import { handleMcp, mcpToolManifest } from "../mcp.js";
import { buildOpenApiSpec } from "../openapi.js";
import { recordAudit } from "../audit.js";

const PUBLIC_RATE_LIMIT = 120; // requests per key per minute

// The programmatic developer surface: the api-key-authed public JSON API (answer / tickets / CSAT /
// NPS) under both /public/* and the versioned /v1/public/* alias, the MCP JSON-RPC endpoint, the
// OpenAPI spec + index, and (authed, admin) api-key management. Public routes carry NO session — they
// are authenticated by a SECRET api key (x-api-key header or body.key) resolved to the tenant
// pre-context; the required scope + per-key rate limit are enforced in the handler (requireApiKey).
// All public paths are listed in server.ts's PUBLIC_ROUTES.
export default async function publicApiRoutes(app: FastifyInstance): Promise<void> {
  // Reusable guard for the api-key-authed public surface. Resolves a secret key, enforces the
  // required scope, and applies per-key rate limiting (in-memory fixed window; a Valkey shared
  // limiter is the prod-HA upgrade). On any failure it sends the response and returns null; on
  // success it returns {tenantId, id, scopes}.
  async function requireApiKey(
    req: FastifyRequest,
    reply: FastifyReply,
    scope: string,
  ): Promise<{ tenantId: string; id: string; scopes: string[] } | null> {
    const rawKey =
      (typeof req.headers["x-api-key"] === "string" ? (req.headers["x-api-key"] as string) : undefined) ??
      (req.body as { key?: string } | undefined)?.key;
    const resolved = await resolveApiKey(rawKey);
    if (!resolved) {
      reply.code(401).send({ error: "invalid api key" });
      return null;
    }
    if (!resolved.scopes.includes(scope)) {
      reply.code(403).send({ error: `api key missing '${scope}' scope` });
      return null;
    }
    const rl = rateLimit(`apikey:${resolved.id}`, PUBLIC_RATE_LIMIT, 60_000);
    reply.header("x-ratelimit-limit", rl.limit);
    reply.header("x-ratelimit-remaining", rl.remaining);
    reply.header("x-ratelimit-reset", rl.resetSec);
    if (!rl.allowed) {
      reply.header("retry-after", rl.resetSec).code(429).send({ error: "rate limit exceeded" });
      return null;
    }
    return resolved;
  }

  // Public API handlers. Registered under BOTH the unversioned `/public/*` (kept for existing keys)
  // and the versioned `/v1/public/*` prefix — same handler, so v1 is a stable documented alias.

  // Public JSON answer API: the structured {answer, citations, confidence, uncertain} wrapper over
  // the same RAG core that drafts agent replies (Kapa/Inkeep's core product surface).
  async function handlePublicAnswer(req: FastifyRequest, reply: FastifyReply) {
    const key = await requireApiKey(req, reply, "answer");
    if (!key) return;
    const parsed = PublicAnswerInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const s = await suggestForQuery(key.tenantId, parsed.data.question, { audience: "public" });
      // "uncertain": nothing corroborated the answer, or the model's confidence is low — a caller
      // uses it to decide whether to show the answer or route to a human.
      const uncertain = s.citations.length === 0 || (s.confidence ?? 0) < 0.5;
      return {
        answer: s.draft,
        citations: s.citations.map((c) => ({ kind: c.kind, title: c.title, snippet: c.snippet })),
        confidence: s.confidence,
        uncertain,
        model: s.model,
      };
    } catch (err) {
      app.log.error({ err }, "public answer failed");
      return reply.code(502).send({ error: "answer unavailable" });
    }
  }

  // Public tickets API — create + list programmatically. POST needs 'tickets:write', GET needs
  // 'tickets:read'. Create funnels through the same inbound core every channel uses (idempotency,
  // outbox, RLS enforced in one place); list returns a trimmed public shape.
  async function handlePublicTicketCreate(req: FastifyRequest, reply: FastifyReply) {
    const key = await requireApiKey(req, reply, "tickets:write");
    if (!key) return;
    const parsed = PublicTicketInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { subject, body, channelType, externalId } = parsed.data;
    const result = await ingestInbound({
      tenantId: key.tenantId,
      body,
      authorType: "customer",
      channelType: channelType || "api",
      externalChannelId: externalId ?? null,
      subject: subject ?? body.slice(0, 80),
    });
    return reply.code(201).send({
      ticketId: result.ticketId,
      messageId: result.messageId,
      created: result.ticketCreated,
    });
  }

  async function handlePublicTicketList(req: FastifyRequest, reply: FastifyReply) {
    const key = await requireApiKey(req, reply, "tickets:read");
    if (!key) return;
    const b = (req.body as { status?: string; limit?: number } | undefined) ?? {};
    const { rows } = await queryTickets(key.tenantId, {
      status: b.status === "open" || b.status === "closed" ? b.status : "all",
      limit: Math.min(Math.max(Number(b.limit) || 25, 1), 100),
      offset: 0,
      sortBy: "updated_at",
      sortDir: "desc",
    });
    return {
      tickets: rows.map((t) => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        priority: t.priority,
        tags: t.tags,
        channelType: t.channel_type,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
      })),
    };
  }

  // Public CSAT submission — the customer rates a resolved ticket (needs 'tickets:write').
  async function handlePublicCsat(req: FastifyRequest, reply: FastifyReply) {
    const key = await requireApiKey(req, reply, "tickets:write");
    if (!key) return;
    const parsed = CsatInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const res = await recordCsat(key.tenantId, parsed.data.ticketId, parsed.data.rating, parsed.data.comment);
    if (!res) return reply.code(404).send({ error: "ticket not found" });
    // Domain event (L0-F3): CSAT arrived — automatable (e.g. a low score → notify/reopen flow).
    emitDomainEvent(key.tenantId, "csat.received", { ticketId: res.ticket_id, rating: res.rating });
    return reply.code(201).send({
      id: res.id,
      ticketId: res.ticket_id,
      rating: res.rating,
      createdAt: res.created_at,
    });
  }

  // Public NPS submission — relationship-level satisfaction (needs 'tickets:write').
  async function handlePublicNps(req: FastifyRequest, reply: FastifyReply) {
    const key = await requireApiKey(req, reply, "tickets:write");
    if (!key) return;
    const parsed = NpsInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const res = await recordNps(key.tenantId, parsed.data.score, parsed.data.comment, parsed.data.ticketId);
    if (!res) return reply.code(404).send({ error: "ticket not found" });
    // Domain event (L0-F3): NPS arrived — automatable (e.g. a detractor → escalation flow).
    emitDomainEvent(key.tenantId, "nps.received", { ticketId: parsed.data.ticketId, score: res.score });
    return reply.code(201).send({ id: res.id, score: res.score, createdAt: res.created_at });
  }

  // Public event tracking (Wave 5): record a custom activity event against a contact identified by
  // external_id or email (upserts the contact first). Needs the 'events:write' scope. This is the
  // programmatic feed behind the per-contact timeline — the analytics/CRM 'track' primitive.
  async function handlePublicEvent(req: FastifyRequest, reply: FastifyReply) {
    const key = await requireApiKey(req, reply, "events:write");
    if (!key) return;
    const parsed = PublicEventInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const event = await trackEvent(key.tenantId, parsed.data);
    if (!event) return reply.code(400).send({ error: "provide an externalId or email to identify the contact" });
    return reply.code(201).send({ id: event.id, contactId: event.contact_id, name: event.name, createdAt: event.created_at });
  }

  for (const prefix of ["/public", "/v1/public"]) {
    app.post(`${prefix}/answer`, handlePublicAnswer);
    app.post(`${prefix}/tickets`, handlePublicTicketCreate);
    app.post(`${prefix}/tickets/list`, handlePublicTicketList);
    app.post(`${prefix}/csat`, handlePublicCsat);
    app.post(`${prefix}/nps`, handlePublicNps);
    app.post(`${prefix}/events`, handlePublicEvent);
  }

  // ---- MCP server (Model Context Protocol) -------------------------------
  // A JSON-RPC endpoint AI coding agents connect to. Auth = an api key via Authorization: Bearer
  // or x-api-key (per-tool scope enforced inside handleMcp). GET /mcp/tools is an unauthenticated
  // manifest so a human can see what's exposed. Registered under /mcp and /v1/mcp.
  async function handleMcpRequest(req: FastifyRequest, reply: FastifyReply) {
    const auth = req.headers["authorization"];
    const bearer = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
    const headerKey = typeof req.headers["x-api-key"] === "string" ? (req.headers["x-api-key"] as string) : undefined;
    const resolved = await resolveApiKey(bearer ?? headerKey);
    if (!resolved) return reply.code(401).send({ error: "invalid api key" });
    const rl = rateLimit(`mcp:${resolved.id}`, PUBLIC_RATE_LIMIT, 60_000);
    reply.header("x-ratelimit-limit", rl.limit).header("x-ratelimit-remaining", rl.remaining);
    if (!rl.allowed) return reply.code(429).send({ error: "rate limit exceeded" });
    const response = await handleMcp((req.body ?? {}) as Record<string, unknown>, {
      tenantId: resolved.tenantId,
      scopes: resolved.scopes,
    });
    if (response === null) return reply.code(202).send(); // notification — no body
    return response;
  }
  app.get("/mcp/tools", async () => ({ tools: mcpToolManifest() }));
  for (const prefix of ["/mcp", "/v1/mcp"]) {
    app.post(prefix, handleMcpRequest);
  }

  // OpenAPI spec (machine-readable contract for the public API) + a small human index. Both
  // unauthenticated — they document how to authenticate, they don't expose tenant data.
  app.get("/openapi.json", async (req) => {
    const proto = (req.headers["x-forwarded-proto"] as string) || "https";
    const host = req.headers.host;
    return buildOpenApiSpec(host ? `${proto}://${host}` : undefined);
  });
  app.get("/v1", async () => ({
    name: "Noola Public API",
    version: "v1",
    docs: "/openapi.json",
    endpoints: [
      { method: "POST", path: "/v1/public/answer", scope: "answer" },
      { method: "POST", path: "/v1/public/tickets", scope: "tickets:write" },
      { method: "POST", path: "/v1/public/tickets/list", scope: "tickets:read" },
      { method: "POST", path: "/v1/public/csat", scope: "tickets:write" },
    ],
  }));

  // ---- API key management (authed, admin, tenant-scoped) ------------------
  // Keys are SECRET — the plaintext is returned exactly once, on creation, and never again (only
  // the prefix is listed after).
  app.get("/api-keys", tenanted(async (tenantId) => ({ keys: await listApiKeys(tenantId) })));

  app.post("/api-keys", tenanted(async (tenantId, req, reply) => {
    const parsed = ApiKeyInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { key, secret } = await createApiKey(
      tenantId,
      { name: parsed.data.name, scopes: parsed.data.scopes },
      req.session?.userId ?? null,
    );
    // `secret` is returned ONCE here and never persisted in plaintext — the client must copy it.
    void recordAudit(tenantId, {
      actorId: req.session?.userId ?? null,
      actorName: req.session?.name ?? null,
      action: "api_key.created",
      entityType: "api_key",
      entityId: key.id,
      meta: { name: parsed.data.name, scopes: parsed.data.scopes },
    });
    return reply.code(201).send({ key, secret });
  }));

  app.delete("/api-keys/:id", tenanted(async (tenantId, req, reply) => {
    const gone = await revokeApiKey(tenantId, (req.params as { id: string }).id);
    if (!gone) return reply.code(404).send({ error: "not found" });
    void recordAudit(tenantId, {
      actorId: req.session?.userId ?? null,
      actorName: req.session?.name ?? null,
      action: "api_key.revoked",
      entityType: "api_key",
      entityId: (req.params as { id: string }).id,
    });
    return { ok: true };
  }));
}
