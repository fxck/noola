import Fastify, { type FastifyRequest } from "fastify";
import fastifyCors, { type FastifyCorsOptions } from "@fastify/cors";
import { connect, StringCodec, type JetStreamClient } from "nats";
import { setNatsConnection } from "./nats-conn.js";
import { appPool, relayPool } from "@repo/db";
import { NATS_STREAM, NATS_STREAM_WILDCARD } from "@repo/contracts";
import { type Session } from "./auth.js";
import { resolveBetterAuthSession } from "./betterauth.js";
import { routeFloor, roleAtLeast } from "./rbac.js";
// Boot-time index/backfill + background sweeps (see the Boot section at the bottom).
import { ensureTicketsCollection, reindexAllTickets, ensureKbCollection, reindexAllArticles, ensureChunksCollection, reindexAllChunks } from "./search.js";
import { ensureThreadsCollection, reindexAllThreads } from "./threads.js";
import { ensureVectorCollections, reindexAllVectors } from "./vector.js";
import { startDiscord } from "./discord-gateway.js";
import { backfillSeedFlows } from "./seedflows.js";
import { runScheduledAutomations } from "./automations.js";
import { detectSlaBreaches } from "./sla.js";
import { runScheduledSourceRefresh } from "./sources.js";
import { wakeSnoozedTickets } from "./tickets.js";
import { runBroadcastScheduler } from "./broadcast-scheduler.js";
import { runRetentionSweep } from "./governance.js";
import { pollEmail } from "./email.js";
import { pollTelegram } from "./telegram.js";
// ---- Route plugins (domain modules; see ./routes/*.ts) ----
import authRoutes from "./routes/auth.js";
import widgetRoutes from "./routes/widget.js";
import publicApiRoutes from "./routes/public-api.js";
import insightRoutes from "./routes/insight.js";
import directoryRoutes from "./routes/directory.js";
import settingsRoutes from "./routes/settings.js";
import knowledgeRoutes from "./routes/knowledge.js";
import inboxOpsRoutes from "./routes/inbox-ops.js";
import policiesRoutes from "./routes/policies.js";
import ticketRoutes from "./routes/tickets.js";
import teamsRoutes from "./routes/teams.js";
import outboundRoutes from "./routes/outbound.js";
import unsubscribeRoutes from "./routes/unsubscribe.js";
import trackingRoutes from "./routes/tracking.js";
import automationRoutes from "./routes/automation.js";
import scimRoutes from "./routes/scim.js";
import uploadsRoutes from "./routes/uploads.js";

// The Bearer-token session resolved on every request (see the onRequest hook below).
// Declared here so req.session is strongly typed everywhere instead of cast ad-hoc.
declare module "fastify" {
  interface FastifyRequest {
    session: Session | null;
  }
}

const sc = StringCodec();
const app = Fastify({ logger: true, trustProxy: true });

// Treat an empty JSON body as {} rather than erroring. Our SPA's fetch client sends
// an application/json content-type even on bodyless POSTs (e.g. /settings/model/test,
// /tickets/:id/suggest); Fastify's default parser rejects that with
// FST_ERR_CTP_EMPTY_JSON_BODY. Parsing empty → {} makes bodyless POSTs just work.
app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
  // Stash the exact raw payload so routes that need byte-fidelity (POST /slack/events —
  // Slack signs the raw body) can re-hash it. Parsing continues as before for everyone
  // else; this is just an extra string reference on the request.
  (req as { rawBody?: string }).rawBody = body as string;
  const s = (body as string).trim();
  if (!s) return done(null, {});
  try {
    done(null, JSON.parse(s));
  } catch (e) {
    (e as { statusCode?: number }).statusCode = 400;
    done(e as Error, undefined);
  }
});

// Slack slash commands + interactivity POST `application/x-www-form-urlencoded`, and Slack signs the
// RAW body — so, like /slack/events, stash the exact bytes before decoding the form into an object
// the routes can read (b.command / b.text / b.payload). Fastify parses only JSON by default.
app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (req, body, done) => {
  (req as { rawBody?: string }).rawBody = body as string;
  const params = new URLSearchParams(body as string);
  const obj: Record<string, string> = {};
  for (const [k, v] of params) obj[k] = v;
  done(null, obj);
});

// CORS — two lanes, one route-aware @fastify/cors delegator:
//   • /public/*  — the Ask-AI widget is embedded on arbitrary customer sites, so this
//     lane reflects ANY Origin. Safe because the API is Bearer + no cookies (nothing to
//     steal cross-origin) and the real guard is the widget key + per-key domain allowlist
//     enforced in the handler (403), not CORS.
//   • everything else — the app is Bearer + no cookies; restrict to our own zerops.app
//     subdomains + localhost, PLUS any configured custom front-end origin (WEB_BASE_URL
//     / CORS_ALLOWED_ORIGINS) — without this, a custom-domain deploy (app.example.com →
//     api.example.com) has its real front-end origin rejected and every browser preflight
//     404s, which curl never surfaces (curl skips preflight).
const corsExtraOrigins = new Set(
  [process.env.WEB_BASE_URL, ...(process.env.CORS_ALLOWED_ORIGINS ?? "").split(",")]
    .map((s) => {
      try {
        return s && s.trim() ? new URL(s.trim()).origin : null;
      } catch {
        return null;
      }
    })
    .filter((s): s is string => s !== null),
);
await app.register(
  fastifyCors,
  () =>
    (req: FastifyRequest, cb: (err: Error | null, opts: FastifyCorsOptions) => void): void => {
      // Key the lane off the ACTUAL request path, NOT req.routeOptions.url. On a CORS preflight the
      // matched route is @fastify/cors's wildcard `options('*')`, so routeOptions.url is '*' — which
      // failed the startsWith('/public/') test, dropped the preflight into the non-public lane
      // (zerops.app-only), disabled CORS, and 404'd the preflight. That silently broke every
      // cross-origin embed (widget /public/ask + /public/conversation) on real customer domains.
      const url = req.url ?? req.routeOptions?.url ?? "";
      if (url.startsWith("/public/")) {
        cb(null, { origin: true, methods: ["POST", "OPTIONS"], allowedHeaders: ["content-type", "x-api-key"], maxAge: 86400 });
        return;
      }
      cb(null, {
        origin: (origin, ocb) => {
          const ok =
            !origin ||
            /^https:\/\/[a-z0-9.-]+\.zerops\.app$/.test(origin) ||
            /^https?:\/\/localhost(:\d+)?$/.test(origin) ||
            corsExtraOrigins.has(origin);
          ocb(null, ok);
        },
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowedHeaders: ["content-type", "authorization"],
        maxAge: 86400,
      });
    },
);

// Bearer-token session: resolve the token to a session on every request. better-auth is the
// SOLE authority — the token is resolved against better-auth's server API; no legacy Valkey path
// remains. Routes read req.session; tenant derives from it (http/tenant.ts's tenantOf/tenanted).
app.decorateRequest("session", null);
app.addHook("onRequest", async (req) => {
  const h = req.headers["authorization"];
  const hasToken = typeof h === "string" && h.startsWith("Bearer ") && h.length > 7;
  req.session = hasToken ? await resolveBetterAuthSession(req.headers) : null;
});

// Global auth gate. Every route requires an authenticated session EXCEPT the explicit
// public lanes below; tenant is derived solely from the session — there is no client-supplied
// tenant fallback. This closes the pre-auth tenant-takeover hole where business routes were
// reachable unauthenticated against a guessable tenant UUID.
//
// Each public lane's tenant source + why it's safe without a session lives in the owning route
// plugin (auth/widget/public-api/policies/automation); this Set is the single gate that exempts them.
const PUBLIC_ROUTES = new Set([
  "GET /health",
  // Auth (mint/inspect a session) + public invite/join accept — ./routes/auth.ts
  "POST /auth/login",
  "POST /auth/login/2fa",
  "POST /auth/signup",
  "POST /auth/logout",
  "GET /auth/me",
  "POST /auth/forgot-password",
  "POST /auth/reset-password",
  "GET /invite/:id",
  "POST /invite/:id/accept",
  "GET /join/:token",
  "POST /join/:token",
  // External channel webhooks — HMAC/signature/token-gated in the handler.
  "POST /email/inbound",
  "POST /slack/events",
  "POST /slack/commands",
  "POST /slack/interactions",
  "GET /whatsapp/webhook",
  "POST /whatsapp/webhook",
  // Ask-AI widget + public help center + messenger — widget-key-scoped, no session (./routes/widget.ts).
  "POST /synthetic/messages",
  "POST /public/ask",
  "POST /public/conversation",
  "POST /public/conversations",
  "POST /public/assistant-mode",
  "GET /public/attachment/:id",
  "GET /public/config",
  "GET /public/instance",
  "POST /public/identify",
  "POST /public/track",
  "GET /widget.js",
  "GET /answers.js",
  "GET /public/kb",
  "GET /public/kb/search",
  "GET /public/kb/:slug",
  "POST /public/deflect",
  // Enterprise SSO — a signing-in user has no session yet (./routes/policies.ts).
  "GET /public/sso/discover",
  "GET /public/sso/start",
  "GET /public/sso/complete",
  // Public API (Wave A) — api-key-authed, resolved to the tenant pre-context (./routes/public-api.ts).
  "POST /public/answer",
  "POST /public/tickets",
  "POST /public/tickets/list",
  "POST /public/csat",
  "POST /public/nps",
  "POST /public/events",
  // Versioned aliases (/v1) — same handlers, stable documented surface (see /openapi.json).
  "POST /v1/public/answer",
  "POST /v1/public/tickets",
  "POST /v1/public/tickets/list",
  "POST /v1/public/csat",
  "POST /v1/public/nps",
  "POST /v1/public/events",
  // SCIM v2 provisioning — Bearer api-key ('scim' scope) resolved pre-context (./routes/scim.ts).
  "GET /scim/v2/Users",
  "GET /scim/v2/Users/:id",
  "POST /scim/v2/Users",
  "PATCH /scim/v2/Users/:id",
  "DELETE /scim/v2/Users/:id",
  "GET /scim/v2/Groups",
  "GET /scim/v2/Groups/:id",
  "POST /scim/v2/Groups",
  "PATCH /scim/v2/Groups/:id",
  "PUT /scim/v2/Groups/:id",
  "DELETE /scim/v2/Groups/:id",
  // MCP server — JSON-RPC lane; api-key auth enforced in the handler, per-tool scope inside handleMcp.
  "POST /mcp",
  "POST /v1/mcp",
  "GET /mcp/tools",
  // OpenAPI spec + API index — unauthenticated discovery docs.
  "GET /openapi.json",
  "GET /v1",
  // Collaborative-canvas persistence (edge → api) — EDGE_SHARED_SECRET-gated (./routes/automation.ts).
  "GET /internal/flow-doc/:automationId",
  "PUT /internal/flow-doc/:automationId",
  // Inbound webhook trigger — unguessable per-automation token resolves the tenant (./routes/automation.ts).
  "POST /hooks/:token",
  // Avatar images — public GET so an <img> (which can't carry a Bearer) can load them; the
  // key is uuid-scoped + traversal-proof (./routes/uploads.ts). Upload stays authed.
  "GET /avatar/*",
  // Marketing opt-out — signed token IS the auth (./routes/unsubscribe.ts). POST is the
  // RFC 8058 one-click endpoint mail clients hit from the List-Unsubscribe header.
  "GET /u/:token",
  "POST /u/:token",
  "GET /u/:token/undo",
  // Engagement tracking — open pixel + signed click redirect (./routes/tracking.ts).
  "GET /t/o/:token",
  "GET /t/c/:token",
]);
app.addHook("onRequest", async (req, reply) => {
  if (req.method === "OPTIONS") return; // CORS preflight (cors plugin already answers it)
  const routeUrl = req.routeOptions?.url ?? req.url;
  // better-auth self-gates its own /ba/* routes (sign-in/sign-up/session) — the global gate
  // must not 401 the very requests that establish a session.
  if (routeUrl.startsWith("/ba")) return;
  if (PUBLIC_ROUTES.has(`${req.method} ${routeUrl}`)) return;
  if (!req.session) {
    return reply.code(401).send({ error: "unauthorized" });
  }
});

// Role gate (RBAC) — runs after the auth gate above (so req.session is set on gated routes).
// A single floor per route: admin surfaces (settings/integrations/member-mgmt) need admin+,
// other business mutations need agent+, reads need viewer+ (see rbac.ts). Role is better-auth's
// live member.role, so a downgrade is effective on the next request. Public / auth / /ba lanes
// are exempt (no session, or better-auth's own AC governs them). This is authorization; RLS
// remains the tenant-isolation backstop underneath.
app.addHook("onRequest", async (req, reply) => {
  if (req.method === "OPTIONS") return;
  const routeUrl = req.routeOptions?.url ?? req.url;
  if (routeUrl.startsWith("/ba")) return; // better-auth's org plugin enforces its own permissions
  if (PUBLIC_ROUTES.has(`${req.method} ${routeUrl}`)) return; // public lanes incl. all /auth/*
  if (!req.session) return; // the auth gate already 401'd; nothing to authorize
  const min = routeFloor(req.method, routeUrl);
  if (!roleAtLeast(req.session.role, min)) {
    return reply.code(403).send({ error: "forbidden", requiredRole: min });
  }
});

let js: JetStreamClient | null = null;

/** Connect NATS + ensure the JetStream stream, retrying forever in the background. */
async function initNats(): Promise<void> {
  const host = process.env.NATS_HOST;
  const port = process.env.NATS_PORT;
  if (!host || !port) {
    app.log.warn("NATS host/port not set — outbox relay disabled");
    return;
  }
  for (;;) {
    try {
      // Pattern A: credential-free servers URL + user/pass options (avoids the
      // connectionString double-auth / URL-parse trap).
      const nc = await connect({
        servers: `${host}:${port}`,
        user: process.env.NATS_USER,
        pass: process.env.NATS_PASS,
        name: "noola-api",
      });
      const jsm = await nc.jetstreamManager();
      try {
        await jsm.streams.info(NATS_STREAM);
      } catch {
        await jsm.streams.add({ name: NATS_STREAM, subjects: [NATS_STREAM_WILDCARD] });
      }
      js = nc.jetstream();
      setNatsConnection(nc); // expose the core connection for run-progress subscribers (runs.ts)
      app.log.info("NATS connected; JetStream stream ready");
      nc.closed().then(() => {
        js = null;
        setNatsConnection(null);
        app.log.warn("NATS connection closed");
        void initNats();
      });
      return;
    } catch (err) {
      app.log.error({ err }, "NATS connect failed; retrying in 2s");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

/** Single-writer outbox drainer: publish committed events, mark published. */
async function drainOutbox(): Promise<void> {
  if (!js) return;
  const c = await relayPool.connect();
  try {
    await c.query("BEGIN");
    const rows = await c.query(
      "SELECT id, subject, payload FROM outbox WHERE published_at IS NULL ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 100",
    );
    for (const row of rows.rows) {
      await js.publish(row.subject, sc.encode(JSON.stringify(row.payload)));
      await c.query("UPDATE outbox SET published_at = now() WHERE id = $1", [row.id]);
    }
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    app.log.error({ err }, "outbox drain failed");
  } finally {
    c.release();
  }
}

// ---- Liveness ------------------------------------------------------------
app.get("/health", async () => {
  let db = "up";
  try {
    await appPool.query("SELECT 1");
  } catch {
    db = "down";
  }
  return { status: "ok", db, nats: js ? "up" : "down" };
});

// ---- Route plugins -------------------------------------------------------
// Every business/auth/public route lives in a domain plugin under ./routes/. The global
// auth/RBAC/session hooks above are inherited by every plugin's routes; public lanes are exempted
// by the PUBLIC_ROUTES set. This file stays a thin composition root: transport, the security
// hooks, NATS/outbox, and boot.
await app.register(authRoutes);
await app.register(widgetRoutes);
await app.register(publicApiRoutes);
await app.register(insightRoutes);
await app.register(directoryRoutes);
await app.register(settingsRoutes);
await app.register(knowledgeRoutes);
await app.register(inboxOpsRoutes);
await app.register(policiesRoutes);
await app.register(ticketRoutes);
await app.register(teamsRoutes);
await app.register(outboundRoutes);
await app.register(unsubscribeRoutes);
await app.register(trackingRoutes);
await app.register(automationRoutes);
await app.register(scimRoutes);
await app.register(uploadsRoutes);

// ---- Boot ----------------------------------------------------------------
const port = Number(process.env.PORT ?? 3000);
await app.listen({ host: "0.0.0.0", port });
void initNats();
startDiscord(app.log);
void ensureTicketsCollection()
  .then(() => reindexAllTickets(app.log))
  .catch((err) => app.log.warn({ err }, "typesense ensure/backfill failed"));
void ensureKbCollection()
  .then(() => reindexAllArticles(app.log))
  .catch((err) => app.log.warn({ err }, "typesense kb ensure/backfill failed"));
void ensureChunksCollection()
  .then(() => reindexAllChunks(app.log))
  .catch((err) => app.log.warn({ err }, "typesense chunks ensure/backfill failed"));
void ensureThreadsCollection()
  .then(() => reindexAllThreads(app.log))
  .catch((err) => app.log.warn({ err }, "typesense threads ensure/backfill failed"));
// Vector store (Qdrant) — ensure collections, then embed+backfill any empty ones.
void ensureVectorCollections()
  .then(() => reindexAllVectors(app.log))
  .catch((err) => app.log.warn({ err }, "qdrant ensure/backfill failed"));
setInterval(() => void drainOutbox(), 500);
// Prune stale answer_claims (§6) — the claim only needs to serialize concurrent answerers within one
// customer turn, so anything older than a couple of days is dead weight. Runs on relayPool as role
// event_relay (BYPASSRLS janitor); the 0076 `GRANT ... DELETE ... TO event_relay` is what lets this
// DELETE succeed rather than throw permission-denied into the swallowed .catch.
const claimsPrune = setInterval(() => {
  void relayPool.query("DELETE FROM answer_claims WHERE created_at < now() - interval '2 days'").catch(() => {});
}, 6 * 60 * 60 * 1000);
claimsPrune.unref?.();
// Dogfood L2: project existing routing_rules / survey_settings into managed seed automations on
// boot, so tenants configured before the projection existed keep routing + surveying with zero
// re-save. Idempotent full-replace; non-blocking (fire-and-forget).
void backfillSeedFlows(app.log);
// Schedule-triggered automations (Agent Studio M2): every minute, fire any enabled `schedule`
// automation whose interval has elapsed. Cross-tenant read on the relay pool; overlap-guarded
// and never throws out of the interval.
setInterval(() => void runScheduledAutomations(app.log), 60_000);
// SLA-breach detector (dogfood L2-D3): every minute, raise sla.at_risk / sla.breached for open
// tickets crossing their target (once per ticket/target/level), so flows can escalate. No-op for
// tenants with SLA disabled; overlap-guarded; never throws.
setInterval(() => void detectSlaBreaches(app.log), 60_000);
// Scheduled source re-crawl: every minute, re-sync any source whose auto-refresh interval has
// elapsed (across all tenants), so a docs URL / repo stays live in the KB. Overlap-guarded; a
// per-source failure never stops the sweep; no-op when no source has a refresh interval set.
setInterval(() => void runScheduledSourceRefresh(app.log), 60_000);
// Snooze wake: every minute, resurface snoozed tickets whose wake time has passed (clear the flag,
// flip whose_turn to 'us'). Cross-tenant; overlap-guarded; no-op when nothing is due.
setInterval(() => void wakeSnoozedTickets(app.log), 60_000);
// Broadcast scheduler (0068): fire due scheduled broadcasts + tick continuous ones (send once
// to first-time audience matchers). Cross-tenant; overlap-guarded; no-op when nothing is live.
setInterval(() => void runBroadcastScheduler(app.log), 30_000);
// Data-retention sweep (0092): hard-delete closed tickets past each tenant's window. Cheap
// no-op for tenants without a window; 6h cadence (idempotent), first pass shortly after boot.
setTimeout(() => void runRetentionSweep(app.log), 120_000);
setInterval(() => void runRetentionSweep(app.log), 6 * 60 * 60_000);
// Inbound email: poll Mailpit (dev/stage) for new customer mail. No-ops when
// MAILPIT_API_URL is unset (like initNats/startDiscord without a backend).
if (process.env.MAILPIT_API_URL) setInterval(() => void pollEmail(app.log), 3000);
// Inbound Telegram: getUpdates long-poll. No-ops entirely without TELEGRAM_BOT_TOKEN (Wave 4).
// Self-serve bots (0092): the tick is a cheap no-op when no tenant has a bot connected
// (the connection set is cached), so the poller no longer env-gates.
setInterval(() => void pollTelegram(app.log), 3000);
