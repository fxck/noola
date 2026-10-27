import type { FastifyInstance, FastifyRequest } from "fastify";
import { PassThrough } from "node:stream";
import {
  IntegrationInput, IntegrationUpdateInput, AutomationInput, AutomationUpdateInput,
  AutomationTestInput, AutomationAuthorInput, type FlowGraph,
} from "@repo/contracts";
import { tenanted } from "../http/tenant.js";
import { presignDownload } from "../storage.js";
import { roleAtLeast } from "../rbac.js";
import { listIntegrations, createIntegration, updateIntegration, deleteIntegration, testIntegration, channelsOverview } from "../integrations.js";
import {
  listAutomations, getAutomation, createAutomation, updateAutomation, deleteAutomation, listRuns,
  runAutomationTest, resolveWebhookRoute, executeAutomation, emitDomainEvent, flowEffect,
  graduateAutomation, EFFECT_MIN_ROLE, type ExecEvent,
} from "../automations.js";
import { authorAutomation } from "../authoring.js";
import { loadFlowDoc, saveFlowDoc } from "../flowdoc.js";
import { listRuns as listRunnerRuns, getRun as getRunnerRun } from "../runs.js";

// The edge's FlowRoom has no DB; it loads/saves a room's encoded Yjs doc over these two routes.
// Gated by a shared secret (service-to-service), not a session — both are PUBLIC lanes.
function edgeAuthed(req: FastifyRequest): boolean {
  const secret = process.env.EDGE_SHARED_SECRET;
  return !!secret && req.headers["x-edge-secret"] === secret;
}

// Agent Studio: outbound connectors (integrations), the automations rules engine (list/author/
// dry-run/live-SSE-execute), the runner's execution history, and the public inbound webhook
// trigger. RBAC-by-effect gates test/execute by the flow's strongest tool effect.
export default async function automationRoutes(app: FastifyInstance): Promise<void> {
  // ---- Integrations (Agent Studio) -----------------------------------------
  // Outbound connectors (notify/action targets) + a unified read of connected inbound channels.
  // Secrets are encrypted at rest, never returned (masked to has_secret).
  app.get("/integrations", tenanted(async (tenantId) => {
    const [integrations, channels] = await Promise.all([listIntegrations(tenantId), channelsOverview(tenantId)]);
    return { integrations, channels };
  }));

  app.post("/integrations", tenanted(async (tenantId, req, reply) => {
    const parsed = IntegrationInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      return reply.code(201).send({ integration: await createIntegration(tenantId, parsed.data) });
    } catch (e) {
      if ((e as Error).message === "encryption_unavailable") {
        return reply.code(400).send({ error: "encryption not configured (MODEL_KEY_SECRET unset)" });
      }
      throw e;
    }
  }));

  app.patch("/integrations/:id", tenanted(async (tenantId, req, reply) => {
    const parsed = IntegrationUpdateInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const integration = await updateIntegration(tenantId, (req.params as { id: string }).id, parsed.data);
      if (!integration) return reply.code(404).send({ error: "not found" });
      return { integration };
    } catch (e) {
      if ((e as Error).message === "encryption_unavailable") {
        return reply.code(400).send({ error: "encryption not configured (MODEL_KEY_SECRET unset)" });
      }
      throw e;
    }
  }));

  app.delete("/integrations/:id", tenanted(async (tenantId, req, reply) => {
    const ok = await deleteIntegration(tenantId, (req.params as { id: string }).id);
    if (!ok) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  }));

  // Health-check a connector by dispatching a test payload; records + returns the outcome.
  app.post("/integrations/:id/test", tenanted(async (tenantId, req, reply) => {
    const out = await testIntegration(tenantId, (req.params as { id: string }).id);
    if (!out) return reply.code(404).send({ error: "not found" });
    return out;
  }));

  // ---- Automations (Agent Studio rules engine) -----------------------------
  // WHEN <trigger> IF <conditions> THEN <actions>. List/get/runs viewer+; authoring + dry-run
  // admin-gated. The engine fires inline off ingest + the ticket routes.
  app.get("/automations", tenanted(async (tenantId) => ({ automations: await listAutomations(tenantId) })));

  app.post("/automations", tenanted(async (tenantId, req, reply) => {
    const parsed = AutomationInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return reply.code(201).send({ automation: await createAutomation(tenantId, parsed.data) });
  }));

  // AI flow authoring (L3-E2): a natural-language prompt → a typed DISABLED draft to review + arm.
  // Static path — MUST precede /automations/:id.
  app.post("/automations/author", tenanted(async (tenantId, req, reply) => {
    const parsed = AutomationAuthorInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const result = await authorAutomation(tenantId, parsed.data.prompt);
    if (result.error) return reply.code(422).send({ error: result.error });
    return { automation: result.automation };
  }));

  // Recent runs across every automation — MUST precede /automations/:id.
  app.get("/automations/runs", tenanted(async (tenantId, req) => {
    const limit = Number((req.query as { limit?: string } | undefined)?.limit ?? 50);
    return { runs: await listRuns(tenantId, undefined, limit) };
  }));

  app.get("/automations/:id", tenanted(async (tenantId, req, reply) => {
    const automation = await getAutomation(tenantId, (req.params as { id: string }).id);
    if (!automation) return reply.code(404).send({ error: "not found" });
    return { automation };
  }));

  app.patch("/automations/:id", tenanted(async (tenantId, req, reply) => {
    const parsed = AutomationUpdateInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const id = (req.params as { id: string }).id;
    // Managed seed automations (projected from a Settings form, L2) are edited in Settings, not
    // Studio — a direct edit would be overwritten on the next projection. Reject it explicitly.
    const existing = await getAutomation(tenantId, id);
    if (existing?.managedBy) return reply.code(409).send({ error: `managed by Settings → ${existing.managedBy}` });
    const automation = await updateAutomation(tenantId, id, parsed.data);
    if (!automation) return reply.code(404).send({ error: "not found" });
    return { automation };
  }));

  app.delete("/automations/:id", tenanted(async (tenantId, req, reply) => {
    const id = (req.params as { id: string }).id;
    const existing = await getAutomation(tenantId, id);
    if (existing?.managedBy) return reply.code(409).send({ error: `managed by Settings → ${existing.managedBy}` });
    const ok = await deleteAutomation(tenantId, id);
    if (!ok) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  }));

  // Fork-to-customize: deep-copy a MANAGED seed flow into an editable, disabled draft and disable
  // the managed source. Admin-gated (matches authoring RBAC). Static-ish path under /:id — fine.
  app.post("/automations/:id/graduate", tenanted(async (tenantId, req, reply) => {
    if (!roleAtLeast(req.session?.role, "admin")) {
      return reply.code(403).send({ error: "Forking a managed flow needs the admin role or higher." });
    }
    const id = (req.params as { id: string }).id;
    const existing = await getAutomation(tenantId, id);
    if (!existing) return reply.code(404).send({ error: "not found" });
    if (!existing.managedBy) return reply.code(400).send({ error: "not a managed flow — nothing to fork" });
    const automation = await graduateAutomation(tenantId, id);
    if (!automation) return reply.code(404).send({ error: "not found" });
    return reply.code(201).send({ automation });
  }));

  app.get("/automations/:id/runs", tenanted(async (tenantId, req) => {
    const limit = Number((req.query as { limit?: string } | undefined)?.limit ?? 50);
    return { runs: await listRuns(tenantId, (req.params as { id: string }).id, limit) };
  }));

  // Dry-run: evaluate a rule against a sample context and return the plan WITHOUT executing.
  app.post("/automations/:id/test", tenanted(async (tenantId, req, reply) => {
    const parsed = AutomationTestInput.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const id = (req.params as { id: string }).id;
    const rule = await getAutomation(tenantId, id);
    if (!rule) return reply.code(404).send({ error: "not found" });
    const need = EFFECT_MIN_ROLE[flowEffect(rule)];
    if (!roleAtLeast(req.session?.role, need)) {
      return reply.code(403).send({ error: `Running this flow needs the ${need} role or higher.` });
    }
    const out = await runAutomationTest(tenantId, id, parsed.data.context);
    if (!out) return reply.code(404).send({ error: "not found" });
    return out;
  }));

  // Live execution (Studio "Run"): walk the flow graph, streaming per-node events over SSE so the
  // canvas lights up as nodes run. dryRun (default true) keeps it safe. Admin-gated by effect.
  app.post("/automations/:id/execute", tenanted(async (tenantId, req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { context?: Record<string, unknown>; dryRun?: boolean };
    const dryRun = body.dryRun !== false; // default safe
    const context = body.context ?? {};

    const rule = await getAutomation(tenantId, id);
    if (!rule) return reply.code(404).send({ error: "not found" });

    const eff = flowEffect(rule);
    const need = EFFECT_MIN_ROLE[eff];
    if (!roleAtLeast(req.session?.role, need)) {
      return reply.code(403).send({ error: `Running this flow needs the ${need} role or higher — it performs ${eff} actions.` });
    }

    const stream = new PassThrough();
    reply.header("content-type", "text/event-stream; charset=utf-8");
    reply.header("cache-control", "no-cache, no-transform");
    reply.header("x-accel-buffering", "no"); // don't let a proxy buffer the event stream
    const send = (event: string, data: unknown) => {
      stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    void (async () => {
      try {
        send("open", { dryRun });
        const result = await executeAutomation(tenantId, id, context, {
          dryRun,
          awaitRun: !dryRun, // a real run blocks on the runner so its output is shown
          emit: (ev: ExecEvent) => send("step", ev),
          automationId: id, // ties runner_runs rows to this flow (Studio history drawer)
        });
        send("done", result ?? { status: "error", error: "not found", trace: [], matched: false });
      } catch (e) {
        send("error", { message: (e as Error).message ?? String(e) });
      } finally {
        stream.end();
      }
    })();

    return reply.send(stream);
  }));

  // ---- Runner runs (agent-studio execution runner) -------------------------
  // Read-only run history from runner_runs (queued→running→succeeded/failed + output). RLS-scoped.
  app.get("/runs", tenanted(async (tenantId, req) => {
    const limit = Number((req.query as { limit?: string } | undefined)?.limit ?? 50);
    return { runs: await listRunnerRuns(tenantId, limit) };
  }));

  app.get("/runs/:id", tenanted(async (tenantId, req, reply) => {
    const run = await getRunnerRun(tenantId, (req.params as { id: string }).id);
    if (!run) return reply.code(404).send({ error: "not found" });
    return { run };
  }));

  // Replay video (0092): a short-lived presigned URL for the run's .webm — direct-to-storage so
  // <video> range requests (scrubbing) work without proxying bytes through the api.
  app.get("/runs/:id/replay", tenanted(async (tenantId, req, reply) => {
    const run = await getRunnerRun(tenantId, (req.params as { id: string }).id);
    if (!run) return reply.code(404).send({ error: "not found" });
    if (!run.replayKey) return reply.code(404).send({ error: "no replay recorded for this run" });
    return { url: await presignDownload(run.replayKey) };
  }));

  // ---- Public inbound webhook trigger (Agent Studio M2) --------------------
  // POST /hooks/:token — an external system fires a webhook-triggered automation. The unguessable
  // token resolves → {tenant, automation} on the relay pool (pre-tenant) BEFORE any tenant context;
  // 404 on unknown. Fire-and-forget → 202. The token IS the capability (no HMAC in v1).
  app.post("/hooks/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const route = await resolveWebhookRoute(token);
    if (!route) return reply.code(404).send({ error: "unknown webhook" });
    const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
    let webhook: unknown = req.body ?? {};
    if (typeof req.body === "string") {
      try { webhook = JSON.parse(req.body); } catch { webhook = {}; }
    }
    emitDomainEvent(route.tenantId, "webhook", { webhook, body: raw });
    return reply.code(202).send({ ok: true });
  });

  // ---- Internal: collaborative-canvas persistence (edge → api) -------------
  // The edge, having authed the user via /auth/me, relays a room's Yjs doc here. Gated by the
  // shared EDGE_SHARED_SECRET header; tenant is taken from the edge and every write runs under RLS
  // via loadFlowDoc/saveFlowDoc. Both routes are PUBLIC lanes (no session; service-to-service).
  app.get("/internal/flow-doc/:automationId", async (req, reply) => {
    if (!edgeAuthed(req)) return reply.code(401).send({ error: "unauthorized" });
    const { automationId } = req.params as { automationId: string };
    const tenantId = (req.query as { tenantId?: string }).tenantId;
    if (!tenantId) return reply.code(400).send({ error: "tenantId required" });
    return loadFlowDoc(tenantId, automationId);
  });

  app.put("/internal/flow-doc/:automationId", async (req, reply) => {
    if (!edgeAuthed(req)) return reply.code(401).send({ error: "unauthorized" });
    const { automationId } = req.params as { automationId: string };
    const body = (req.body ?? {}) as { tenantId?: string; doc?: string; graph?: FlowGraph | null };
    if (!body.tenantId || !body.doc) return reply.code(400).send({ error: "tenantId and doc required" });
    const ok = await saveFlowDoc(body.tenantId, automationId, body.doc, body.graph ?? null);
    return { ok };
  });
}
