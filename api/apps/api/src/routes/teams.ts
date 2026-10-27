import type { FastifyInstance } from "fastify";
import { TeamInput, TeamPatch, UserRoutingInput } from "@repo/contracts";
import { tenanted } from "../http/tenant.js";
import { listTeams, createTeam, updateTeam, deleteTeam, DuplicateTeamError } from "../teams.js";
import { updateUserRouting, reassignOpenTickets } from "../assignments.js";

// Teams (Wave 3) — CRUD over the tenant's agent groups + per-agent routing signals
// (Routing v2). Reading is viewer+ (pickers and the inbox rail need the list); shaping the
// team structure / agent routing is admin+ (ADMIN_ROUTES in rbac.ts).
export default async function teamsRoutes(app: FastifyInstance): Promise<void> {
  // Per-agent routing signals: skills, out-of-office, load cap. With outOfOffice: true and
  // reassign: true, the agent's open queue is handed back (team tickets round-robin to an
  // eligible teammate, the rest return to Unassigned).
  app.patch("/users/:id/routing", tenanted(async (tenantId, req, reply) => {
    const parsed = UserRoutingInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { reassign, ...patch } = parsed.data;
    const user = await updateUserRouting(tenantId, (req.params as { id: string }).id, patch);
    if (!user) return reply.code(404).send({ error: "not found" });
    let handback: { reassigned: number; unassigned: number } | undefined;
    if (reassign && user.out_of_office) {
      handback = await reassignOpenTickets(tenantId, user.id);
    }
    return { user, ...(handback ? { handback } : {}) };
  }));

  app.get("/teams", tenanted(async (tenantId) => ({ teams: await listTeams(tenantId) })));

  app.post("/teams", tenanted(async (tenantId, req, reply) => {
    const parsed = TeamInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      return reply.code(201).send({ team: await createTeam(tenantId, parsed.data) });
    } catch (err) {
      if (err instanceof DuplicateTeamError) return reply.code(409).send({ error: err.message });
      if ((err as { code?: string }).code === "23503") return reply.code(400).send({ error: "invalid member" });
      throw err;
    }
  }));

  app.patch("/teams/:id", tenanted(async (tenantId, req, reply) => {
    const parsed = TeamPatch.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const team = await updateTeam(tenantId, (req.params as { id: string }).id, parsed.data);
      if (!team) return reply.code(404).send({ error: "not found" });
      return { team };
    } catch (err) {
      if (err instanceof DuplicateTeamError) return reply.code(409).send({ error: err.message });
      if ((err as { code?: string }).code === "23503") return reply.code(400).send({ error: "invalid member" });
      throw err;
    }
  }));

  app.delete("/teams/:id", tenanted(async (tenantId, req, reply) => {
    const gone = await deleteTeam(tenantId, (req.params as { id: string }).id);
    if (!gone) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  }));
}
