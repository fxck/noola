import type { FastifyInstance } from "fastify";
import {
  ContactInput, BulkContactsInput, ContactMergeInput, CompanyInput,
  FeatureRequestInput, FeatureLinkInput, SegmentInput, ContactEventInput,
  ContactFilterConditions, ContactFilterConditionGroups, CONTACT_SORT_FIELDS, type ContactSortField,
} from "@repo/contracts";
import { tenanted } from "../http/tenant.js";
import {
  listContacts, getContact, createContact, updateContact, deleteContact,
  upsertContact, bulkUpsertContacts, contactHistory, mergeContacts, listContactIdentities,
} from "../contacts.js";
import { recordContactEvent, listContactEvents } from "../contact-events.js";
import { listCompanies, countCompanies, getCompany, createCompany, updateCompany, deleteCompany, bulkUpsertCompanies, ensureCompaniesByName, type HealthBand } from "../companies.js";
import { listCompanyCustomValues, putCompanyCustomValues } from "../customfields.js";
import {
  listFeatureRequests, getFeatureRequest, createFeatureRequest, updateFeatureRequest,
  deleteFeatureRequest, linkTicketToFeature, unlinkTicketFromFeature, featuresForTicket,
} from "../features.js";
import { listSegments, getSegment, createSegment, updateSegment, deleteSegment } from "../segments.js";
import { recordAudit } from "../audit.js";
import { exportContactData, eraseContact } from "../governance.js";
import { roleAtLeast } from "../rbac.js";
import { parseCsvContacts, parseCsvCompanies } from "../csv-import.js";

// The customer-directory surfaces: contacts (people), companies (accounts + health), feature
// requests (voice-of-customer with ticket evidence), and saved segments (reusable filters).
export default async function directoryRoutes(app: FastifyInstance): Promise<void> {
  // ---- Contacts directory + back-office sync -------------------------------
  // A tenant-scoped people/company directory with free-form attributes (RLS). The idempotent
  // upsert (external_id, else email) + bulk import are the back-office sync surface; GET
  // /:id/history links a contact to their tickets via the email channel.
  app.get("/contacts", tenanted(async (tenantId, req, reply) => {
    const q = (req.query as Record<string, string | undefined> | undefined) ?? {};
    const num = (v: string | undefined): number | undefined => (v === undefined ? undefined : Number(v));

    // The filter builder ships its conditions as a JSON-encoded `filters` query param.
    let conditions;
    if (q.filters) {
      let raw: unknown;
      try {
        raw = JSON.parse(q.filters);
      } catch {
        return reply.code(400).send({ error: "invalid filters json" });
      }
      const parsed = ContactFilterConditions.safeParse(raw);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      conditions = parsed.data;
    }
    // OR groups ride a second JSON param (`filterGroups`) so the flat `filters` shape stays
    // exactly what older clients send.
    let conditionGroups;
    if (q.filterGroups) {
      let raw: unknown;
      try {
        raw = JSON.parse(q.filterGroups);
      } catch {
        return reply.code(400).send({ error: "invalid filterGroups json" });
      }
      const parsed = ContactFilterConditionGroups.safeParse(raw);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      conditionGroups = parsed.data;
    }

    const sortBy = (CONTACT_SORT_FIELDS as readonly string[]).includes(q.sortBy ?? "")
      ? (q.sortBy as ContactSortField)
      : undefined;
    const sort = sortBy ? { by: sortBy, dir: q.sortDir === "asc" ? ("asc" as const) : ("desc" as const) } : undefined;

    const identity = q.identity === "identified" || q.identity === "anonymous" ? q.identity : undefined;
    return listContacts(tenantId, {
      q: q.q, company: q.company, attrKey: q.attrKey, attrValue: q.attrValue,
      conditions, conditionGroups, identity, sort, limit: num(q.limit), offset: num(q.offset),
    });
  }));

  app.post("/contacts", tenanted(async (tenantId, req, reply) => {
    const parsed = ContactInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const contact = await createContact(tenantId, parsed.data);
      return reply.code(201).send({ contact });
    } catch (e) {
      if ((e as { code?: string }).code === "23505") {
        return reply.code(409).send({ error: "contact already exists (external_id or email) — use /contacts/upsert" });
      }
      throw e;
    }
  }));

  // Idempotent upsert — the back-office sync entrypoint. Requires an idempotency key
  // (external_id OR email); a plain create with neither goes through POST /contacts.
  app.post("/contacts/upsert", tenanted(async (tenantId, req, reply) => {
    const parsed = ContactInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    if (!parsed.data.external_id && !parsed.data.email) {
      return reply.code(400).send({ error: "upsert requires external_id or email" });
    }
    const { contact, created } = await upsertContact(tenantId, parsed.data);
    return reply.code(created ? 201 : 200).send({ contact, created });
  }));

  // Bulk import — a batch upserted in one transaction; returns created/updated counts.
  app.post("/contacts/bulk", tenanted(async (tenantId, req, reply) => {
    const parsed = BulkContactsInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return bulkUpsertContacts(tenantId, parsed.data.contacts);
  }));

  app.get("/contacts/:id", tenanted(async (tenantId, req, reply) => {
    const contact = await getContact(tenantId, (req.params as { id: string }).id);
    if (!contact) return reply.code(404).send({ error: "not found" });
    return { contact };
  }));

  app.patch("/contacts/:id", tenanted(async (tenantId, req, reply) => {
    const parsed = ContactInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const contact = await updateContact(tenantId, (req.params as { id: string }).id, parsed.data);
      if (!contact) return reply.code(404).send({ error: "not found" });
      return { contact };
    } catch (e) {
      if ((e as { code?: string }).code === "23505") {
        return reply.code(409).send({ error: "external_id or email already in use" });
      }
      throw e;
    }
  }));

  app.delete("/contacts/:id", tenanted(async (tenantId, req, reply) => {
    const gone = await deleteContact(tenantId, (req.params as { id: string }).id);
    if (!gone) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  }));

  // Marketing subscription flip — the agent-side lane for manual opt-out/opt-in requests
  // (the customer-side lane is the public signed-token /u/:token page). Broadcast resolution
  // suppresses unsubscribed contacts on every channel.
  app.post("/contacts/:id/subscription", tenanted(async (tenantId, req, reply) => {
    const unsubscribed = (req.body as { unsubscribed?: unknown } | undefined)?.unsubscribed;
    if (typeof unsubscribed !== "boolean") {
      return reply.code(400).send({ error: "body must be { unsubscribed: boolean }" });
    }
    const id = (req.params as { id: string }).id;
    const { setSubscription } = await import("../unsubscribe.js");
    const who = await setSubscription(tenantId, id, unsubscribed);
    if (!who) return reply.code(404).send({ error: "not found" });
    const contact = await getContact(tenantId, id);
    return { contact };
  }));

  // The contact's ticket history (their tickets + latest message per ticket), linked via the
  // A contact's conversations across every channel — linked by the first-class tickets.contact_id
  // (omnichannel, migration 0062), not the old email-string match.
  // GDPR (0092): everything we hold about a person, as a portable JSON download.
  app.get("/contacts/:id/export", tenanted(async (tenantId, req, reply) => {
    const bundle = await exportContactData(tenantId, (req.params as { id: string }).id);
    if (!bundle) return reply.code(404).send({ error: "not found" });
    return reply
      .header("content-disposition", `attachment; filename="contact-export.json"`)
      .send(bundle);
  }));

  // GDPR erasure (0092): the contact AND their conversations, hard-deleted. Admin-only —
  // this is destructive and legally meaningful, not an everyday directory action.
  app.post("/contacts/:id/erase", tenanted(async (tenantId, req, reply) => {
    if (!roleAtLeast(req.session?.role, "admin")) {
      return reply.code(403).send({ error: "admin role required" });
    }
    const gone = await eraseContact(tenantId, (req.params as { id: string }).id, req.session?.userId ?? null);
    if (!gone) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  }));

  // CSV import (0092): header-mapped rows ride the same idempotent upsert as /contacts/bulk.
  // Body is the raw CSV text (the SPA reads the file client-side); returns per-outcome counts.
  app.post("/contacts/import", { bodyLimit: 24 * 1024 * 1024 }, tenanted(async (tenantId, req, reply) => {
    const b = (req.body ?? {}) as Partial<{ csv: string }>;
    if (!b.csv || typeof b.csv !== "string") return reply.code(400).send({ error: "csv text is required" });
    if (b.csv.length > 20_000_000) return reply.code(413).send({ error: "csv too large (20MB max)" });
    const parsed = parseCsvContacts(b.csv);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    if (!parsed.rows.length) return reply.code(400).send({ error: "no importable rows found" });
    // Connect people to accounts: resolve each row's free-text company name → a real company_id
    // (creating the company if it's new), so imported contacts land linked, not just labeled.
    const companyMap = await ensureCompaniesByName(tenantId, parsed.rows.map((r) => r.company ?? ""));
    let linked = 0;
    for (const r of parsed.rows) {
      const id = r.company ? companyMap.get(r.company.trim().toLowerCase()) : undefined;
      if (id) { r.company_id = id; linked++; }
    }
    const result = await bulkUpsertContacts(tenantId, parsed.rows);
    await recordAudit(tenantId, {
      actorId: req.session?.userId ?? null, action: "contacts.imported", entityType: "contact",
      meta: { created: result.created, updated: result.updated, skipped: parsed.skipped, linked },
    }).catch(() => {});
    return { ...result, skipped: parsed.skipped, linked };
  }));

  app.get("/contacts/:id/history", tenanted(async (tenantId, req, reply) => {
    const contact = await getContact(tenantId, (req.params as { id: string }).id);
    if (!contact) return reply.code(404).send({ error: "not found" });
    return contactHistory(tenantId, (req.params as { id: string }).id);
  }));

  // The contact's linked channel handles (the "Known on" list) — one row per channel the same person
  // has been recognized on (email, chat widget, discord, …).
  app.get("/contacts/:id/identities", tenanted(async (tenantId, req, reply) => {
    const contact = await getContact(tenantId, (req.params as { id: string }).id);
    if (!contact) return reply.code(404).send({ error: "not found" });
    return { identities: await listContactIdentities(tenantId, (req.params as { id: string }).id) };
  }));

  // Custom data events (Wave 5): the contact's activity timeline. GET reads newest-first; POST
  // records a named event with optional metadata (also reachable via the public api-key /public/events).
  app.get("/contacts/:id/events", tenanted(async (tenantId, req, reply) => {
    const contact = await getContact(tenantId, (req.params as { id: string }).id);
    if (!contact) return reply.code(404).send({ error: "not found" });
    return { events: await listContactEvents(tenantId, (req.params as { id: string }).id) };
  }));

  app.post("/contacts/:id/events", tenanted(async (tenantId, req, reply) => {
    const parsed = ContactEventInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const event = await recordContactEvent(tenantId, (req.params as { id: string }).id, parsed.data.name, parsed.data.metadata);
    if (!event) return reply.code(404).send({ error: "not found" });
    return reply.code(201).send({ event });
  }));

  // Identity resolution: merge a duplicate contact into this one. The path id is KEPT; the body's
  // `dropId` is folded in and deleted. Audited (an irreversible directory mutation).
  app.post("/contacts/:id/merge", tenanted(async (tenantId, req, reply) => {
    const parsed = ContactMergeInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const keepId = (req.params as { id: string }).id;
    const contact = await mergeContacts(tenantId, keepId, parsed.data.dropId);
    if (!contact) return reply.code(404).send({ error: "not found" });
    void recordAudit(tenantId, {
      actorId: req.session?.userId ?? null,
      actorName: req.session?.name ?? null,
      action: "contact.merged",
      entityType: "contact",
      entityId: keepId,
      meta: { droppedId: parsed.data.dropId },
    });
    return { contact };
  }));

  // ---- Companies (account records) -----------------------------------------
  // First-class accounts with a rolled-up health score (open tickets + negative sentiment + CSAT).
  app.get("/companies", tenanted(async (tenantId, req) => {
    const query = (req.query as Record<string, string | undefined>) ?? {};
    const num = (v: string | undefined): number | undefined => (v === undefined || v === "" ? undefined : Number(v));
    const band = ["healthy", "at_risk", "critical"].includes(query.band ?? "") ? (query.band as HealthBand) : undefined;
    const opts = {
      q: query.q,
      band,
      limit: num(query.limit),
      offset: num(query.offset),
      sortBy: query.sort,
      sortDir: query.dir === "desc" ? ("desc" as const) : query.dir === "asc" ? ("asc" as const) : undefined,
    };
    const [companies, total] = await Promise.all([listCompanies(tenantId, opts), countCompanies(tenantId, opts)]);
    return { companies, total };
  }));

  app.get("/companies/:id", tenanted(async (tenantId, req, reply) => {
    const company = await getCompany(tenantId, (req.params as { id: string }).id);
    if (!company) return reply.code(404).send({ error: "not found" });
    return { company };
  }));

  app.post("/companies", tenanted(async (tenantId, req, reply) => {
    const parsed = CompanyInput.safeParse(req.body);
    if (!parsed.success || !parsed.data.name) return reply.code(400).send({ error: "name is required" });
    try {
      return reply.code(201).send({ company: await createCompany(tenantId, { name: parsed.data.name, domain: parsed.data.domain, plan: parsed.data.plan, attributes: parsed.data.attributes }) });
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return reply.code(409).send({ error: "a company with that name already exists" });
      throw e;
    }
  }));

  // CSV import (Intercom migration): header-mapped company rows, keyed idempotently on lower(name).
  // Body is the raw CSV text (the SPA reads the file client-side); returns per-outcome counts. Run
  // this BEFORE the contacts import so people link to already-provisioned accounts (though the
  // contacts import also create-if-missing links, so order is convenience, not a hard requirement).
  app.post("/companies/import", { bodyLimit: 24 * 1024 * 1024 }, tenanted(async (tenantId, req, reply) => {
    const b = (req.body ?? {}) as Partial<{ csv: string }>;
    if (!b.csv || typeof b.csv !== "string") return reply.code(400).send({ error: "csv text is required" });
    if (b.csv.length > 20_000_000) return reply.code(413).send({ error: "csv too large (20MB max)" });
    const parsed = parseCsvCompanies(b.csv);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    if (!parsed.rows.length) return reply.code(400).send({ error: "no importable rows found" });
    const result = await bulkUpsertCompanies(tenantId, parsed.rows);
    await recordAudit(tenantId, {
      actorId: req.session?.userId ?? null, action: "companies.imported", entityType: "company",
      meta: { created: result.created, updated: result.updated, skipped: parsed.skipped },
    }).catch(() => {});
    return { ...result, skipped: parsed.skipped };
  }));

  app.patch("/companies/:id", tenanted(async (tenantId, req, reply) => {
    const parsed = CompanyInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid body" });
    const company = await updateCompany(tenantId, (req.params as { id: string }).id, parsed.data);
    if (!company) return reply.code(404).send({ error: "not found" });
    return { company };
  }));

  // Company custom-field values (0090) — the entity='company' defs' value surface.
  app.get("/companies/:id/custom-values", tenanted(async (tenantId, req) => {
    const { id } = req.params as { id: string };
    return { values: await listCompanyCustomValues(tenantId, id) };
  }));

  app.put("/companies/:id/custom-values", tenanted(async (tenantId, req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { values?: Record<string, unknown> };
    if (!body.values || typeof body.values !== "object") return reply.code(400).send({ error: "values object required" });
    const values = Object.fromEntries(Object.entries(body.values).map(([k, v]) => [k, String(v ?? "")]));
    return { values: await putCompanyCustomValues(tenantId, id, values) };
  }));

  app.delete("/companies/:id", tenanted(async (tenantId, req, reply) => {
    const gone = await deleteCompany(tenantId, (req.params as { id: string }).id);
    if (!gone) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  }));

  // ---- Feature requests (voice of customer) --------------------------------
  // A request accumulates ticket evidence; the evidence count is the demand signal.
  app.get("/feature-requests", tenanted(async (tenantId, req) => {
    const status = (req.query as { status?: string }).status;
    return { requests: await listFeatureRequests(tenantId, status) };
  }));

  app.get("/feature-requests/:id", tenanted(async (tenantId, req, reply) => {
    const request = await getFeatureRequest(tenantId, (req.params as { id: string }).id);
    if (!request) return reply.code(404).send({ error: "not found" });
    return { request };
  }));

  app.post("/feature-requests", tenanted(async (tenantId, req, reply) => {
    const parsed = FeatureRequestInput.safeParse(req.body);
    if (!parsed.success || !parsed.data.title) return reply.code(400).send({ error: "title is required" });
    return reply.code(201).send({ request: await createFeatureRequest(tenantId, { title: parsed.data.title, description: parsed.data.description, status: parsed.data.status }) });
  }));

  app.patch("/feature-requests/:id", tenanted(async (tenantId, req, reply) => {
    const parsed = FeatureRequestInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid body" });
    const request = await updateFeatureRequest(tenantId, (req.params as { id: string }).id, parsed.data);
    if (!request) return reply.code(404).send({ error: "not found" });
    return { request };
  }));

  app.delete("/feature-requests/:id", tenanted(async (tenantId, req, reply) => {
    const gone = await deleteFeatureRequest(tenantId, (req.params as { id: string }).id);
    if (!gone) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  }));

  app.post("/feature-requests/:id/tickets", tenanted(async (tenantId, req, reply) => {
    const parsed = FeatureLinkInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const ok = await linkTicketToFeature(tenantId, (req.params as { id: string }).id, parsed.data.ticketId);
    if (!ok) return reply.code(404).send({ error: "request or ticket not found" });
    return { ok: true };
  }));

  app.delete("/feature-requests/:id/tickets/:ticketId", tenanted(async (tenantId, req) => {
    const { id, ticketId } = req.params as { id: string; ticketId: string };
    await unlinkTicketFromFeature(tenantId, id, ticketId);
    return { ok: true };
  }));

  // The feature requests a ticket is linked to (ticket rail).
  app.get("/tickets/:id/features", tenanted(async (tenantId, req) => ({
    features: await featuresForTicket(tenantId, (req.params as { id: string }).id),
  })));

  // ---- Saved Segments -------------------------------------------------------
  // Named, reusable filter definitions over a resource (contacts for now). The definition carries
  // the same filter-builder grammar the contacts directory applies; the segment is just
  // persistence + a name, tenant-scoped (RLS). `?resource=` scopes the list.
  app.get("/segments", tenanted(async (tenantId, req) => {
    const resource = (req.query as { resource?: string } | undefined)?.resource;
    return { segments: await listSegments(tenantId, resource) };
  }));

  app.post("/segments", tenanted(async (tenantId, req, reply) => {
    const parsed = SegmentInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const segment = await createSegment(tenantId, {
      name: parsed.data.name, resource: parsed.data.resource, definition: parsed.data.definition,
    });
    return reply.code(201).send({ segment });
  }));

  app.get("/segments/:id", tenanted(async (tenantId, req, reply) => {
    const segment = await getSegment(tenantId, (req.params as { id: string }).id);
    if (!segment) return reply.code(404).send({ error: "not found" });
    return { segment };
  }));

  app.patch("/segments/:id", tenanted(async (tenantId, req, reply) => {
    const parsed = SegmentInput.partial().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const segment = await updateSegment(tenantId, (req.params as { id: string }).id, {
      name: parsed.data.name, definition: parsed.data.definition,
    });
    if (!segment) return reply.code(404).send({ error: "not found" });
    return { segment };
  }));

  app.delete("/segments/:id", tenanted(async (tenantId, req, reply) => {
    const gone = await deleteSegment(tenantId, (req.params as { id: string }).id);
    if (!gone) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  }));
}
