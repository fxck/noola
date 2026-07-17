import type { FastifyInstance } from "fastify";
import { PersonaInput, KnowledgeGapUpdateInput, ReportConfigInput } from "@repo/contracts";
import { tenanted } from "../http/tenant.js";
import { getOverview, getWorkload, getSlaReport, getOpsDashboard, getCsatReport, getContainment } from "../analytics.js";
import { listTopics, ticketsForTopic, reclassifyGeneral } from "../topics.js";
import { listScores, qaSummary, scoreTicket, backfillScores, qaByAgent, qaCsatCorrelation } from "../qa.js";
import { runSimulation, listSimulations, getSimulation } from "../simulate.js";
import { getPersona, putPersona } from "../persona.js";
import { listAudit, verifyAuditChain } from "../audit.js";
import { listKnowledgeGaps, updateKnowledgeGap } from "../gaps.js";

// Reporting & insight surfaces: analytics overview, the Topics explorer, Conversation QA
// (scores + coaching + CSAT correlation), the agent-simulation harness, agent persona,
// the tamper-evident audit log, and the content-gap worklist. All read-mostly; the
// admin-gated ones (persona PUT, /audit) are enforced by rbac.ts ADMIN_ROUTES upstream.
export default async function insightRoutes(app: FastifyInstance): Promise<void> {
  // Support analytics overview (viewer+): the reporting dashboard reads this whole payload.
  app.get("/analytics/overview", tenanted(async (tenantId) => ({ overview: await getOverview(tenantId) })));

  // Live workload (viewer+): open/waiting per agent + per team, closed-today throughput.
  app.get("/analytics/workload", tenanted(async (tenantId) => ({ workload: await getWorkload(tenantId) })));

  // Ops dashboard (viewer+): the live floor view — queue state, today's flow, oldest-waiting,
  // breaching-soon. Agents-online comes from the edge presence channel client-side.
  app.get("/analytics/ops", tenanted(async (tenantId) => ({ ops: await getOpsDashboard(tenantId) })));

  // Containment funnel (viewer+): deflected / AI-resolved / AI-assisted / human over ?weeks.
  app.get("/analytics/containment", tenanted(async (tenantId, req) => {
    const q = (req.query as { weeks?: string }) ?? {};
    const weeks = q.weeks && !Number.isNaN(Number(q.weeks)) ? Number(q.weeks) : 8;
    return { containment: await getContainment(tenantId, weeks) };
  }));

  // CSAT trends + agent leaderboard (viewer+) over ?weeks (default 12).
  app.get("/analytics/csat-report", tenanted(async (tenantId, req) => {
    const q = (req.query as { weeks?: string }) ?? {};
    const weeks = q.weeks && !Number.isNaN(Number(q.weeks)) ? Number(q.weeks) : 12;
    return { report: await getCsatReport(tenantId, weeks) };
  }));

  // Report builder-lite (viewer+): run a metrics-catalog report config → bucketed series
  // (+ previous-period totals with compare). Saved configs ride /segments?resource=reports.
  app.post("/analytics/report", tenanted(async (tenantId, req, reply) => {
    const parsed = ReportConfigInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const { runReport } = await import("../reports.js");
      return { report: await runReport(tenantId, parsed.data) };
    } catch (e) {
      if ((e as Error).message === "invalid range") return reply.code(400).send({ error: "invalid range" });
      throw e;
    }
  }));

  // The metrics catalog (labels/units) so the web builder never hardcodes it.
  app.get("/analytics/report-metrics", tenanted(async () => {
    const { REPORT_METRICS } = await import("../reports.js");
    return { metrics: REPORT_METRICS };
  }));

  // SLA adherence (viewer+): met-vs-breached by week/priority/team over ?weeks (default 8).
  app.get("/analytics/sla", tenanted(async (tenantId, req) => {
    const q = (req.query as { weeks?: string }) ?? {};
    const weeks = q.weeks && !Number.isNaN(Number(q.weeks)) ? Number(q.weeks) : 8;
    return { report: await getSlaReport(tenantId, weeks) };
  }));

  // ---- Topics explorer (viewer+): what customers contact us about + trend -----
  app.get("/topics", tenanted(async (tenantId) => ({ topics: await listTopics(tenantId) })));

  // Reclassify the 'general' bucket (admin, bounded batch) — re-runs classification with
  // the current rules + model so the catch-all stops absorbing half the volume.
  app.post("/topics/reclassify", tenanted(async (tenantId, req) => {
    const limit = Number((req.body as { limit?: number } | undefined)?.limit) || 200;
    return reclassifyGeneral(tenantId, limit);
  }));

  app.get("/topics/:topic/tickets", tenanted(async (tenantId, req) => {
    const topic = decodeURIComponent((req.params as { topic: string }).topic);
    return { tickets: await ticketsForTopic(tenantId, topic) };
  }));

  // ---- Conversation QA (viewer+ reads; scoring is a lead action) --------------
  // The review list is worst-first by default; ?band filters to one grade. POST re-scores one ticket
  // or backfills the recent unscored set. Scoring also fires automatically when a ticket closes.
  app.get("/qa", tenanted(async (tenantId, req) => {
    const q = req.query as { band?: string; limit?: string };
    const [scores, summary] = await Promise.all([
      listScores(tenantId, { band: q.band || undefined, limit: q.limit ? Number(q.limit) : undefined }),
      qaSummary(tenantId),
    ]);
    return { scores, summary };
  }));

  app.post("/qa/tickets/:id/score", tenanted(async (tenantId, req, reply) => {
    const score = await scoreTicket(tenantId, (req.params as { id: string }).id);
    if (!score) return reply.code(404).send({ error: "ticket not found or has no messages" });
    return { score };
  }));

  app.post("/qa/backfill", tenanted(async (tenantId, req) => {
    const limit = (req.body as { limit?: number } | undefined)?.limit;
    return { scored: await backfillScores(tenantId, typeof limit === "number" ? limit : 50) };
  }));

  // QA coaching leaderboard (per-agent rollup) + does QA track CSAT — both viewer+ reads.
  app.get("/qa/agents", tenanted(async (tenantId) => ({ agents: await qaByAgent(tenantId) })));
  app.get("/qa/csat-correlation", tenanted(async (tenantId) => ({ correlation: await qaCsatCorrelation(tenantId) })));

  // ---- Agent simulation / eval harness (lead action; reuses the resolver) -----
  // POST runs a sim over a sample of past tickets (bounded model spend); GET lists past runs; GET :id
  // returns a run + its per-ticket rows. Scoring never sends anything — it drafts + grades in place.
  app.get("/simulations", tenanted(async (tenantId) => ({ runs: await listSimulations(tenantId) })));

  app.post("/simulations", tenanted(async (tenantId, req, reply) => {
    const body = (req.body as { sampleSize?: number; label?: string } | undefined) ?? {};
    return reply.code(201).send(await runSimulation(tenantId, { sampleSize: body.sampleSize, label: body.label }));
  }));

  app.get("/simulations/:id", tenanted(async (tenantId, req, reply) => {
    const out = await getSimulation(tenantId, (req.params as { id: string }).id);
    if (!out) return reply.code(404).send({ error: "not found" });
    return out;
  }));

  // ---- Agent persona (admin-only mutation; the assistant's voice) -------------
  // GET returns the tenant persona (or defaults); PUT upserts. PUT /persona is in ADMIN_ROUTES.
  app.get("/persona", tenanted(async (tenantId) => ({ persona: await getPersona(tenantId) })));

  app.put("/persona", tenanted(async (tenantId, req, reply) => {
    const parsed = PersonaInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return { persona: await putPersona(tenantId, parsed.data) };
  }));

  // ---- Audit log (admin-only; compliance surface) --------------------------
  // The tamper-evident hash-chain. GET /audit pages the log; GET /audit/verify recomputes the whole
  // chain and reports the first break (or ok). Both are in ADMIN_ROUTES (rbac.ts).
  app.get("/audit", tenanted(async (tenantId, req) => {
    const q = req.query as { limit?: string; before?: string; entityType?: string; entityId?: string };
    return listAudit(tenantId, {
      limit: q.limit ? Number(q.limit) : undefined,
      before: q.before ? Number(q.before) : undefined,
      entityType: q.entityType || undefined,
      entityId: q.entityId || undefined,
    });
  }));

  app.get("/audit/verify", tenanted(async (tenantId) => verifyAuditChain(tenantId)));

  // Content-gap worklist (the knowledge-loop): questions the KB couldn't answer, clustered by
  // occurrence. Read is viewer+; triaging a gap (resolve/dismiss) is agent+ (a normal mutation, not
  // in ADMIN_ROUTES). ?status=open|resolved|dismissed|all (default open).
  app.get("/knowledge-gaps", tenanted(async (tenantId, req) => {
    const q = req.query as { status?: string; limit?: string };
    return listKnowledgeGaps(tenantId, { status: q.status, limit: q.limit ? Number(q.limit) : undefined });
  }));

  app.patch("/knowledge-gaps/:id", tenanted(async (tenantId, req, reply) => {
    const parsed = KnowledgeGapUpdateInput.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const gap = await updateKnowledgeGap(tenantId, (req.params as { id: string }).id, parsed.data);
    if (!gap) return reply.code(404).send({ error: "not_found" });
    return { gap };
  }));
}
