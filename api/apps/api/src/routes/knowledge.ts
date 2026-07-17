import type { FastifyInstance } from "fastify";
import { KbCollectionInput, KbArticleInput, DocumentInput, SourceInput, SourceUpdateInput } from "@repo/contracts";
import { tenanted } from "../http/tenant.js";
import {
  createArticle, listArticles, getArticle, updateArticle, deleteArticle, searchArticles,
  listCollections, createCollection, updateCollection, deleteCollection,
} from "../kb.js";
import { ingestDocument, listDocuments, getDocument, getDocumentContent, deleteDocument, searchDocuments } from "../documents.js";
import { listSources, getSource, createSource, updateSource, deleteSource, syncSource, maskSource } from "../sources.js";
import { presignUpload, storageSmoke } from "../storage.js";

// The knowledge & content surfaces: KB articles + collections, uploaded documents (the RAG
// ingest/retrieval half), live sources (connectors), attachment presign, and a storage smoke.
export default async function knowledgeRoutes(app: FastifyInstance): Promise<void> {
  // ---- Knowledge Base -------------------------------------------------------
  app.get("/kb", tenanted(async (tenantId, req) => {
    const query = (req.query as { q?: string; collection?: string } | undefined) ?? {};
    if (query.q && query.q.trim()) return { articles: await searchArticles(tenantId, query.q.trim()) };
    if (query.collection === "none") return { articles: await listArticles(tenantId, null) };
    if (query.collection) return { articles: await listArticles(tenantId, query.collection) };
    return { articles: await listArticles(tenantId) };
  }));

  // ---- KB Collections (taxonomy) --------------------------------------------
  // Declared static so `/kb/collections` always wins over the `/kb/:id` param route.
  app.get("/kb/collections", tenanted(async (tenantId) => ({ collections: await listCollections(tenantId) })));

  app.post("/kb/collections", tenanted(async (tenantId, req, reply) => {
    const parsed = KbCollectionInput.safeParse(req.body);
    if (!parsed.success || !parsed.data.name) return reply.code(400).send({ error: "name is required" });
    const collection = await createCollection(tenantId, { name: parsed.data.name, ...parsed.data });
    return reply.code(201).send({ collection });
  }));

  app.patch("/kb/collections/:id", tenanted(async (tenantId, req, reply) => {
    const parsed = KbCollectionInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const collection = await updateCollection(tenantId, (req.params as { id: string }).id, parsed.data);
    if (!collection) return reply.code(404).send({ error: "not found" });
    return { collection };
  }));

  app.delete("/kb/collections/:id", tenanted(async (tenantId, req, reply) => {
    const gone = await deleteCollection(tenantId, (req.params as { id: string }).id);
    if (!gone) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  }));

  app.post("/kb", tenanted(async (tenantId, req, reply) => {
    const parsed = KbArticleInput.safeParse(req.body);
    if (!parsed.success || !parsed.data.title) return reply.code(400).send({ error: "title is required" });
    const a = await createArticle(tenantId, parsed.data.title, parsed.data.body ?? "", parsed.data.collection_id ?? null, {
      status: parsed.data.status, visibility: parsed.data.visibility,
    });
    return reply.code(201).send({ article: a });
  }));

  app.get("/kb/:id", tenanted(async (tenantId, req, reply) => {
    const a = await getArticle(tenantId, (req.params as { id: string }).id);
    if (!a) return reply.code(404).send({ error: "not found" });
    return { article: a };
  }));

  app.patch("/kb/:id", tenanted(async (tenantId, req, reply) => {
    const parsed = KbArticleInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid body" });
    const a = await updateArticle(tenantId, (req.params as { id: string }).id, parsed.data);
    if (!a) return reply.code(404).send({ error: "not found" });
    return { article: a };
  }));

  app.delete("/kb/:id", tenanted(async (tenantId, req, reply) => {
    const gone = await deleteArticle(tenantId, (req.params as { id: string }).id);
    if (!gone) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  }));

  // ---- Document ingestion ---------------------------------------------------
  // Upload → object-storage → extract → chunk → keyword index. GET /documents/search is the
  // retrieval half of RAG (chunk passages, tenant-scoped, cite by document).
  app.get("/documents/search", tenanted(async (tenantId, req, reply) => {
    const q = (req.query as { q?: string } | undefined)?.q ?? "";
    try {
      return { chunks: await searchDocuments(tenantId, q) };
    } catch (err) {
      app.log.error({ err }, "document search failed");
      return reply.code(502).send({ error: "search unavailable" });
    }
  }));

  app.get("/documents", tenanted(async (tenantId) => ({ documents: await listDocuments(tenantId) })));

  app.post("/documents", tenanted(async (tenantId, req, reply) => {
    const parsed = DocumentInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const doc = await ingestDocument(tenantId, parsed.data.filename, parsed.data.contentType, parsed.data.content);
      return reply.code(201).send({ document: doc });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      if (status === 415) return reply.code(415).send({ error: (err as Error).message });
      app.log.error({ err }, "document ingest failed");
      return reply.code(500).send({ error: "ingest failed" });
    }
  }));

  app.get("/documents/:id", tenanted(async (tenantId, req, reply) => {
    const d = await getDocument(tenantId, (req.params as { id: string }).id);
    if (!d) return reply.code(404).send({ error: "not found" });
    return { document: d };
  }));

  // Raw stored text of an uploaded document — backs the KB document viewer (RLS-scoped read).
  app.get("/documents/:id/content", tenanted(async (tenantId, req, reply) => {
    try {
      const content = await getDocumentContent(tenantId, (req.params as { id: string }).id);
      if (!content) return reply.code(404).send({ error: "not found" });
      return content;
    } catch (err) {
      app.log.error({ err }, "document content read failed");
      return reply.code(502).send({ error: "content unavailable" });
    }
  }));

  app.delete("/documents/:id", tenanted(async (tenantId, req, reply) => {
    const gone = await deleteDocument(tenantId, (req.params as { id: string }).id);
    if (!gone) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  }));

  // ---- Live sources (connectors) -------------------------------------------
  // A tenant registers an external source (docs URL / sitemap); a sync crawls + ingests it through
  // the document pipeline tagged by source_id so it's citable. Sync is fire-and-forget.
  app.get("/sources", tenanted(async (tenantId) => ({ sources: (await listSources(tenantId)).map(maskSource) })));

  app.get("/sources/:id", tenanted(async (tenantId, req, reply) => {
    const src = await getSource(tenantId, (req.params as { id: string }).id);
    if (!src) return reply.code(404).send({ error: "not found" });
    return { source: maskSource(src) };
  }));

  app.post("/sources", tenanted(async (tenantId, req, reply) => {
    const parsed = SourceInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const src = await createSource(tenantId, {
      kind: parsed.data.kind, label: parsed.data.label, config: parsed.data.config,
      refreshIntervalMinutes: parsed.data.refreshIntervalMinutes,
    });
    void syncSource(tenantId, src.id).catch((err) => app.log.warn({ err, sourceId: src.id }, "initial sync failed"));
    return reply.code(201).send({ source: maskSource({ ...src, status: "syncing" }) });
  }));

  // Update editable settings (label + per-kind config). kind is immutable; write-only credentials
  // are preserved when omitted.
  app.patch("/sources/:id", tenanted(async (tenantId, req, reply) => {
    const parsed = SourceUpdateInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const src = await updateSource(tenantId, (req.params as { id: string }).id, parsed.data);
    if (!src) return reply.code(404).send({ error: "not found" });
    return { source: maskSource(src) };
  }));

  app.post("/sources/:id/sync", tenanted(async (tenantId, req, reply) => {
    const { id } = req.params as { id: string };
    const src = await getSource(tenantId, id);
    if (!src) return reply.code(404).send({ error: "not found" });
    void syncSource(tenantId, id).catch((err) => app.log.warn({ err, sourceId: id }, "sync failed"));
    return { status: "syncing" };
  }));

  app.delete("/sources/:id", tenanted(async (tenantId, req, reply) => {
    const gone = await deleteSource(tenantId, (req.params as { id: string }).id);
    if (!gone) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  }));

  // Presigned upload URL for a real attachment (browser PUTs directly to storage; the key is
  // namespaced to the caller's tenant).
  app.post("/attachments/presign", tenanted(async (tenantId, req, reply) => {
    const body = (req.body ?? {}) as { filename?: string; contentType?: string };
    if (!body.filename) return reply.code(400).send({ error: "filename required" });
    return presignUpload(tenantId, body.filename, body.contentType ?? "application/octet-stream");
  }));

  // Object-storage wiring smoke — round-trips a tiny object. No tenant needed.
  app.get("/storage/smoke", async (_req, reply) => {
    try {
      return await storageSmoke();
    } catch (err) {
      app.log.error({ err }, "storage smoke failed");
      return reply.code(502).send({ ok: false, error: "storage unavailable" });
    }
  });
}
