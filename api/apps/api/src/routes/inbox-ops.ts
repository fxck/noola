import type { FastifyInstance } from "fastify";
import {
  MacroInput, NoteInput, CustomFieldDefInput, CustomFieldDefPatch, CustomFieldValueInput,
  AgentRunInput, TicketTypeInput, TicketTypePatch, BulkTicketInput,
} from "@repo/contracts";
import { tenanted } from "../http/tenant.js";
import { roleAtLeast } from "../rbac.js";
import { listMacros, createMacro, updateMacro, deleteMacro } from "../macros.js";
import { listNotes, addNote, deleteNote } from "../notes.js";
import { getTicketCsat } from "../csat.js";
import { listFieldDefs, createFieldDef, updateFieldDef, deleteFieldDef, getTicketValues, setTicketValue } from "../customfields.js";
import { listTicketTypes, createTicketType, updateTicketType, deleteTicketType } from "../tickettypes.js";
import { bulkTickets, TICKET_PRIORITIES } from "../tickets.js";
import { runTicketAgent, listAgentRunsForTicket, emitDomainEvent, TOOL_REGISTRY, agentToolsEffect, EFFECT_MIN_ROLE } from "../automations.js";

// Ticket-operations surfaces: macros (canned replies), internal notes, CSAT read, custom fields
// (definitions + per-ticket values), the on-demand interactive agent run, ticket types, and bulk
// ticket actions. Day-to-day inbox tooling; admin-only schema mutations are gated by rbac.ts.
export default async function inboxOpsRoutes(app: FastifyInstance): Promise<void> {
  // ---- Macros / canned responses -------------------------------------------
  app.get("/macros", tenanted(async (tenantId) => ({ macros: await listMacros(tenantId) })));

  app.post("/macros", tenanted(async (tenantId, req, reply) => {
    const parsed = MacroInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const macro = await createMacro(tenantId, { name: parsed.data.name, body: parsed.data.body, shortcut: parsed.data.shortcut ?? null });
    return reply.code(201).send({ macro });
  }));

  app.patch("/macros/:id", tenanted(async (tenantId, req, reply) => {
    const parsed = MacroInput.partial().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const macro = await updateMacro(tenantId, (req.params as { id: string }).id, {
      name: parsed.data.name, body: parsed.data.body, shortcut: parsed.data.shortcut,
    });
    if (!macro) return reply.code(404).send({ error: "not found" });
    return { macro };
  }));

  app.delete("/macros/:id", tenanted(async (tenantId, req, reply) => {
    const gone = await deleteMacro(tenantId, (req.params as { id: string }).id);
    if (!gone) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  }));

  // ---- Internal notes / side conversations ---------------------------------
  // Agent-only annotations on a ticket, never dispatched. The note author is the session user.
  app.get("/tickets/:id/notes", tenanted(async (tenantId, req) => ({
    notes: await listNotes(tenantId, (req.params as { id: string }).id),
  })));

  app.post("/tickets/:id/notes", tenanted(async (tenantId, req, reply) => {
    const parsed = NoteInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const ticketId = (req.params as { id: string }).id;
    const note = await addNote(tenantId, ticketId, {
      authorId: req.session?.userId ?? null,
      authorName: req.session?.name ?? null,
      body: parsed.data.body,
      mentionIds: parsed.data.mentionIds,
    });
    if (!note) return reply.code(404).send({ error: "ticket not found" });
    // Domain event (L0-F3): an internal note was added — automatable (e.g. @mention → notify).
    emitDomainEvent(tenantId, "note.added", { ticketId, mentionIds: parsed.data.mentionIds });
    return reply.code(201).send({ note });
  }));

  app.delete("/tickets/:id/notes/:noteId", tenanted(async (tenantId, req, reply) => {
    const gone = await deleteNote(tenantId, (req.params as { noteId: string }).noteId);
    if (!gone) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  }));

  // ---- CSAT (read side) ----------------------------------------------------
  // The latest customer-satisfaction response for a ticket (submissions arrive via POST /public/csat).
  app.get("/tickets/:id/csat", tenanted(async (tenantId, req) => ({
    csat: await getTicketCsat(tenantId, (req.params as { id: string }).id),
  })));

  // ---- Custom fields -------------------------------------------------------
  // Tenant-defined ticket attributes. Definitions are admin-managed; reading definitions +
  // reading/writing a ticket's values is agent-level day-to-day work.
  app.get("/custom-fields", tenanted(async (tenantId, req) => {
    const q = (req.query ?? {}) as { entity?: string };
    const entity = q.entity === "ticket" || q.entity === "company" ? q.entity : undefined;
    return { fields: await listFieldDefs(tenantId, entity) };
  }));

  app.post("/custom-fields", tenanted(async (tenantId, req, reply) => {
    const parsed = CustomFieldDefInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const field = await createFieldDef(tenantId, parsed.data);
      return reply.code(201).send({ field });
    } catch (err) {
      if ((err as { code?: string }).code === "23505") return reply.code(409).send({ error: "a field with that key already exists" });
      throw err;
    }
  }));

  app.patch("/custom-fields/:id", tenanted(async (tenantId, req, reply) => {
    const parsed = CustomFieldDefPatch.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const field = await updateFieldDef(tenantId, (req.params as { id: string }).id, parsed.data);
    if (!field) return reply.code(404).send({ error: "not found" });
    return { field };
  }));

  app.delete("/custom-fields/:id", tenanted(async (tenantId, req, reply) => {
    const gone = await deleteFieldDef(tenantId, (req.params as { id: string }).id);
    if (!gone) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  }));

  app.get("/tickets/:id/custom-values", tenanted(async (tenantId, req) => ({
    values: await getTicketValues(tenantId, (req.params as { id: string }).id),
  })));

  app.put("/tickets/:id/custom-values", tenanted(async (tenantId, req, reply) => {
    const parsed = CustomFieldValueInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const ok = await setTicketValue(tenantId, (req.params as { id: string }).id, parsed.data.fieldId, parsed.data.value);
    if (!ok) return reply.code(404).send({ error: "ticket or field not found" });
    return { ok: true };
  }));

  // ---- Interactive autonomous agent ----------------------------------------
  // Run the SAME multi-step tool loop Studio's "agent" node uses, on demand against one ticket.
  // Defaults to a SAFE dry run; live=true executes. RBAC-by-effect: the role needed depends on
  // what the agent's tools can do.
  app.post("/tickets/:id/agent-run", tenanted(async (tenantId, req, reply) => {
    const parsed = AgentRunInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { instructions, tools, maxSteps, live, model } = parsed.data;
    const need = EFFECT_MIN_ROLE[agentToolsEffect(tools)];
    if (!roleAtLeast(req.session?.role, need)) {
      return reply.code(403).send({ error: `Running an agent with these tools needs the ${need} role or higher.` });
    }
    const out = await runTicketAgent(tenantId, (req.params as { id: string }).id, { instructions, tools, maxSteps, model }, { dryRun: !live });
    if (!out) return reply.code(404).send({ error: "ticket not found" });
    const o = out.output as { steps?: string[]; actions?: unknown[]; runId?: string | null };
    return { live: !!live, runId: o.runId ?? null, steps: o.steps ?? [], actions: out.results.map((r) => ({ type: r.type, ok: r.ok, detail: r.detail })) };
  }));

  // The persisted agent-loop traces for a ticket (item 17) — what the agent did and why,
  // step by step, for the ticket timeline. Viewer+ (read-only audit).
  app.get("/tickets/:id/agent-runs", tenanted(async (tenantId, req) => ({
    runs: await listAgentRunsForTicket(tenantId, (req.params as { id: string }).id),
  })));

  // The automation/agent tool catalog (dogfood L0-F1) — the ONE registry with each tool's effect
  // + label. Drives the Studio inspector's effect badges. Viewer+ (read-only introspection).
  app.get("/automations/tools", async () => ({
    tools: Object.entries(TOOL_REGISTRY).map(([name, meta]) => ({ name, effect: meta.effect, label: meta.label })),
  }));

  // ---- Ticket types --------------------------------------------------------
  // Tenant-defined taxonomy. Definitions are admin-managed; setting a ticket's type is via
  // PATCH /tickets/:id. Reading the list is viewer+.
  app.get("/ticket-types", tenanted(async (tenantId) => ({ types: await listTicketTypes(tenantId) })));

  app.post("/ticket-types", tenanted(async (tenantId, req, reply) => {
    const parsed = TicketTypeInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const type = await createTicketType(tenantId, parsed.data);
      return reply.code(201).send({ type });
    } catch (err) {
      if ((err as { code?: string }).code === "23505") return reply.code(409).send({ error: "a type with that name already exists" });
      throw err;
    }
  }));

  app.patch("/ticket-types/:id", tenanted(async (tenantId, req, reply) => {
    const parsed = TicketTypePatch.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const type = await updateTicketType(tenantId, (req.params as { id: string }).id, parsed.data);
    if (!type) return reply.code(404).send({ error: "not found" });
    return { type };
  }));

  app.delete("/ticket-types/:id", tenanted(async (tenantId, req, reply) => {
    const gone = await deleteTicketType(tenantId, (req.params as { id: string }).id);
    if (!gone) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  }));

  // ---- Bulk ticket actions -------------------------------------------------
  // Apply one action (close/reopen/assign/team/priority/tag) to many tickets at once (agent+).
  app.post("/tickets/bulk", tenanted(async (tenantId, req, reply) => {
    const parsed = BulkTicketInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { ids, action, value } = parsed.data;
    if (action === "priority" && !(TICKET_PRIORITIES as readonly string[]).includes(value ?? "")) {
      return reply.code(400).send({ error: "invalid priority" });
    }
    if (action === "tag" && !value?.trim()) return reply.code(400).send({ error: "tag value required" });
    try {
      const affected = await bulkTickets(tenantId, ids, action, value ?? null);
      // A bulk close is still a close: fire ticket.closed per newly-closed ticket so the seeded
      // survey flow (and any tenant ticket.closed automation) runs uniformly — fixes bulk closes
      // silently skipping CSAT. Post-commit, fire-and-forget.
      if (action === "close") for (const id of affected) emitDomainEvent(tenantId, "ticket.closed", { ticketId: id });
      return { updated: affected.length };
    } catch (err) {
      if ((err as { code?: string }).code === "23503") return reply.code(400).send({ error: "invalid assignee or team" });
      throw err;
    }
  }));
}
