import { withTenant } from "@repo/db";
import type { FlowGraph } from "@repo/contracts";

// Collaborative-canvas persistence (Lane 4b), reached only by the edge's FlowRoom over the
// internal /internal/flow-doc endpoints (shared-secret gated in server.ts). The edge holds no
// database, so it saves/loads a room's encoded Yjs doc here. Everything runs under withTenant,
// so RLS scopes reads/writes to the tenant the edge derived from the session — a room can never
// touch another tenant's doc even though the endpoint is service-to-service.

/** Load a room's persisted CRDT doc (base64) + the automation's current graph. When no doc has
 *  been saved yet, the edge seeds the room from `graph` (the single-player automation). */
export async function loadFlowDoc(
  tenantId: string,
  automationId: string,
): Promise<{ doc: string | null; graph: FlowGraph | null }> {
  return withTenant(tenantId, async (c) => {
    const d = await c.query(
      "SELECT doc FROM flow_docs WHERE tenant_id = current_tenant() AND automation_id = $1",
      [automationId],
    );
    const doc = d.rowCount ? (d.rows[0].doc as Buffer).toString("base64") : null;
    const g = await c.query(
      "SELECT graph FROM automations WHERE tenant_id = current_tenant() AND id = $1",
      [automationId],
    );
    const graph = g.rowCount ? ((g.rows[0].graph as FlowGraph) ?? null) : null;
    return { doc, graph };
  });
}

/** Persist a room's encoded doc + project its graph back into automations.graph so the engine
 *  runs the collaborative edits. No-op (returns false) if the automation isn't in this tenant. */
export async function saveFlowDoc(
  tenantId: string,
  automationId: string,
  docBase64: string,
  graph: FlowGraph | null,
): Promise<boolean> {
  const buf = Buffer.from(docBase64, "base64");
  return withTenant(tenantId, async (c) => {
    const exists = await c.query(
      "SELECT 1 FROM automations WHERE tenant_id = current_tenant() AND id = $1",
      [automationId],
    );
    if (!exists.rowCount) return false;
    await c.query(
      `INSERT INTO flow_docs (tenant_id, automation_id, doc, updated_at)
       VALUES (current_tenant(), $1, $2, now())
       ON CONFLICT (tenant_id, automation_id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()`,
      [automationId, buf],
    );
    if (graph && Array.isArray(graph.nodes)) {
      await c.query(
        "UPDATE automations SET graph = $2::jsonb, updated_at = now() WHERE tenant_id = current_tenant() AND id = $1",
        [automationId, JSON.stringify(graph)],
      );
    }
    return true;
  });
}
