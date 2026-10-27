import type { FastifyInstance } from "fastify";
import { UserPreferencesPatch } from "@repo/contracts";
import { getPreferences, updatePreferences } from "../preferences.js";

export default async function preferencesRoutes(app: FastifyInstance) {
  app.get("/me/preferences", async (req, reply) => {
    const s = req.session;
    if (!s) return reply.code(401).send({ error: "unauthorized" });
    return { preferences: await getPreferences(s.tenantId, s.userId) };
  });

  app.patch("/me/preferences", async (req, reply) => {
    const s = req.session;
    if (!s) return reply.code(401).send({ error: "unauthorized" });
    const parsed = UserPreferencesPatch.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return { preferences: await updatePreferences(s.tenantId, s.userId, parsed.data) };
  });
}
