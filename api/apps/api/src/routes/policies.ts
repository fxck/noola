import type { FastifyInstance } from "fastify";
import { SlaPolicyInput, RoutingRuleInput, RoutingRulePatch, SurveySettingsInput, SsoConnectionInput, SsoConnectionPatch } from "@repo/contracts";
import { tenanted } from "../http/tenant.js";
import { getSlaPolicy, upsertSlaPolicy } from "../sla.js";
import { listRoutingRules, createRoutingRule, updateRoutingRule, deleteRoutingRule } from "../routing.js";
import { getSurveySettings, upsertSurveySettings } from "../surveys.js";
import { listSso, createSso, updateSso, deleteSso, discoverSsoByEmail, startSso, ssoSessionToken } from "../betterauth.js";

// Workspace policies: SLA targets, auto-assignment routing rules, auto-survey toggles, and
// enterprise SSO (per-tenant IdP providers). The three /public/sso/* routes are unauthenticated
// (a signing-in user has no session yet) and stay plain handlers.
export default async function policiesRoutes(app: FastifyInstance): Promise<void> {
  // ---- SLA policy ----------------------------------------------------------
  // One policy per tenant (first-response + resolution targets). Per-ticket SLA state is computed
  // on the fly from timestamps.
  app.get("/settings/sla", tenanted(async (tenantId) => ({ policy: await getSlaPolicy(tenantId) })));

  app.put("/settings/sla", tenanted(async (tenantId, req, reply) => {
    const parsed = SlaPolicyInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return { policy: await upsertSlaPolicy(tenantId, parsed.data) };
  }));

  // ---- Routing & assignment rules ------------------------------------------
  // Ordered per-tenant auto-assignment rules; first match assigns a new ticket. The engine runs
  // from ingest on ticket creation — these routes only manage the rule set.
  app.get("/routing-rules", tenanted(async (tenantId) => ({ rules: await listRoutingRules(tenantId) })));

  app.post("/routing-rules", tenanted(async (tenantId, req, reply) => {
    const parsed = RoutingRuleInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      return reply.code(201).send({ rule: await createRoutingRule(tenantId, parsed.data) });
    } catch (err) {
      if ((err as { code?: string }).code === "23503") return reply.code(400).send({ error: "invalid assignee" });
      throw err;
    }
  }));

  app.patch("/routing-rules/:id", tenanted(async (tenantId, req, reply) => {
    const parsed = RoutingRulePatch.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const rule = await updateRoutingRule(tenantId, (req.params as { id: string }).id, parsed.data);
      if (!rule) return reply.code(404).send({ error: "not found" });
      return { rule };
    } catch (err) {
      if ((err as { code?: string }).code === "23503") return reply.code(400).send({ error: "invalid assignee" });
      throw err;
    }
  }));

  app.delete("/routing-rules/:id", tenanted(async (tenantId, req, reply) => {
    const gone = await deleteRoutingRule(tenantId, (req.params as { id: string }).id);
    if (!gone) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  }));

  // ---- Auto satisfaction surveys -------------------------------------------
  // Per-tenant toggles: auto-deliver a CSAT and/or NPS prompt when a ticket resolves.
  app.get("/settings/surveys", tenanted(async (tenantId) => ({ settings: await getSurveySettings(tenantId) })));

  app.put("/settings/surveys", tenanted(async (tenantId, req, reply) => {
    const parsed = SurveySettingsInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return { settings: await upsertSurveySettings(tenantId, parsed.data) };
  }));

  // ---- Enterprise SSO (OIDC / SAML) — @better-auth/sso ---------------------
  // Per-tenant IdP providers routed by email domain, stored + driven by the first-party plugin.
  // These routes are a thin admin adapter; the client secret lives in the plugin's config and is
  // never returned. Sign-in/discovery are PUBLIC.
  app.get("/sso-connections", tenanted(async (tenantId) => ({ connections: await listSso(tenantId) })));

  app.post("/sso-connections", tenanted(async (tenantId, req, reply) => {
    const parsed = SsoConnectionInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const out = await createSso(req.headers.authorization ?? "", tenantId, parsed.data);
    if (!out.ok) return reply.code(out.status).send({ error: out.error });
    return reply.code(201).send({ connection: out.connection });
  }));

  app.patch("/sso-connections/:id", tenanted(async (tenantId, req, reply) => {
    const parsed = SsoConnectionPatch.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const out = await updateSso(req.headers.authorization ?? "", tenantId, (req.params as { id: string }).id, parsed.data);
    if (!out.ok) return reply.code(out.status).send({ error: out.error });
    return { connection: out.connection };
  }));

  app.delete("/sso-connections/:id", tenanted(async (tenantId, req, reply) => {
    const gone = await deleteSso(req.headers.authorization ?? "", tenantId, (req.params as { id: string }).id);
    if (!gone) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  }));

  // Public: does this email's domain use SSO? Drives the login page's "Sign in with SSO".
  app.get("/public/sso/discover", async (req, reply) => {
    const email = (req.query as { email?: string }).email ?? "";
    if (!email) return reply.code(400).send({ error: "email required" });
    const hit = await discoverSsoByEmail(email);
    if (!hit.sso) return { sso: false };
    return { sso: true, provider: hit.provider, name: hit.name, connectionId: hit.providerId };
  });

  // The SPA reaches /public/sso/start?connectionId=<providerId> (or ?email=). We ask the plugin for
  // the authorize redirect, pointing its post-auth callbackURL at our same-origin /complete bridge.
  app.get("/public/sso/start", async (req, reply) => {
    const q = req.query as { connectionId?: string; email?: string };
    if (!q.connectionId && !q.email) return reply.code(400).send({ error: "connectionId or email required" });
    const base = `${req.protocol}://${req.headers.host}`;
    const out = await startSso(
      q.connectionId ? { providerId: q.connectionId } : { email: q.email },
      `${base}/public/sso/complete`,
      `${base}/public/sso/complete`,
    );
    if (!out.ok) return reply.code(400).send({ error: out.error });
    return reply.redirect(out.url);
  });

  // The Bearer bridge. The plugin's /ba/sso/callback established a cookie session and redirected the
  // browser here; we resolve that cookie to its raw token and hand it to the SPA in the URL fragment
  // (fragments stay out of proxy logs). No cookie session ⇒ the friendly failure page.
  app.get("/public/sso/complete", async (req, reply) => {
    reply.header("content-type", "text/html; charset=utf-8");
    const webBase = (process.env.WEB_BASE_URL || `${req.protocol}://${req.headers.host}`).replace(/\/+$/, "");
    const token = await ssoSessionToken(req.headers as unknown as import("node:http").IncomingHttpHeaders);
    if (token) {
      const target = `${webBase}/sso/callback#token=${encodeURIComponent(token)}`;
      return `<!doctype html><meta charset="utf-8"><title>Signing in…</title><meta http-equiv="refresh" content="0;url=${target}"><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;text-align:center"><h1>Signing you in…</h1><p>If you are not redirected, <a href="${target}">continue</a>.</p></body>`;
    }
    return `<!doctype html><meta charset="utf-8"><title>SSO</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;text-align:center"><h1>Single sign-on didn't complete</h1><p>The identity provider handoff didn't establish a session. Please try again, or sign in with your email and password.</p><a href="${webBase}/login">Back to sign in</a></body>`;
  });
}
