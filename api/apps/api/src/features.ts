import { withTenant } from "@repo/db";

// Feature-request tracking — the voice-of-customer board. A request has a lifecycle status and
// accumulates *evidence*: the support tickets linked to it. The evidence count is the demand signal
// (how many customers hit this), so product can prioritize by real conversations, not guesses.

export const FEATURE_STATUSES = ["open", "planned", "in_progress", "shipped", "declined"] as const;
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];

export interface FeatureRequest {
  id: string;
  title: string;
  description: string;
  status: string;
  evidence_count: number;
  created_at: string;
  updated_at: string;
}

const COLS = "id, title, description, status, created_at, updated_at";

const mapRow = (r: Record<string, unknown>): FeatureRequest => ({
  id: r.id as string,
  title: r.title as string,
  description: (r.description as string) ?? "",
  status: r.status as string,
  evidence_count: Number(r.evidence_count ?? 0),
  created_at: r.created_at instanceof Date ? (r.created_at as Date).toISOString() : String(r.created_at),
  updated_at: r.updated_at instanceof Date ? (r.updated_at as Date).toISOString() : String(r.updated_at),
});

/** All requests with their evidence (linked-ticket) count, most-demanded first. */
export async function listFeatureRequests(tenantId: string, status?: string): Promise<FeatureRequest[]> {
  return withTenant(tenantId, async (c) => {
    const params: unknown[] = [];
    let filter = "";
    if (status && (FEATURE_STATUSES as readonly string[]).includes(status)) {
      params.push(status); filter = `WHERE fr.status = $${params.length}`;
    }
    const r = await c.query(
      `SELECT fr.${COLS.split(", ").join(", fr.")},
              (SELECT count(*)::int FROM feature_request_tickets t WHERE t.request_id = fr.id) AS evidence_count
         FROM feature_requests fr
         ${filter}
        ORDER BY evidence_count DESC, fr.updated_at DESC
        LIMIT 500`,
      params,
    );
    return (r.rows as Record<string, unknown>[]).map(mapRow);
  });
}

export interface FeatureRequestDetail extends FeatureRequest {
  tickets: { id: string; subject: string; status: string }[];
}

export async function getFeatureRequest(tenantId: string, id: string): Promise<FeatureRequestDetail | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT fr.${COLS.split(", ").join(", fr.")},
              (SELECT count(*)::int FROM feature_request_tickets t WHERE t.request_id = fr.id) AS evidence_count
         FROM feature_requests fr WHERE fr.id = $1`,
      [id],
    );
    if (!r.rowCount) return null;
    const tickets = await c.query(
      `SELECT t.id, t.subject, t.status
         FROM feature_request_tickets frt
         JOIN tickets t ON t.id = frt.ticket_id AND t.tenant_id = frt.tenant_id
        WHERE frt.request_id = $1 ORDER BY frt.created_at DESC LIMIT 200`,
      [id],
    );
    return {
      ...mapRow(r.rows[0] as Record<string, unknown>),
      tickets: tickets.rows.map((x) => ({ id: x.id as string, subject: x.subject as string, status: x.status as string })),
    };
  });
}

export async function createFeatureRequest(tenantId: string, input: { title: string; description?: string; status?: string }): Promise<FeatureRequest> {
  const status = (FEATURE_STATUSES as readonly string[]).includes(input.status ?? "") ? input.status! : "open";
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO feature_requests (tenant_id, title, description, status)
       VALUES (current_tenant(), $1, $2, $3) RETURNING ${COLS}, 0 AS evidence_count`,
      [input.title, input.description ?? "", status],
    );
    return mapRow(r.rows[0] as Record<string, unknown>);
  });
}

export async function updateFeatureRequest(tenantId: string, id: string, patch: { title?: string; description?: string; status?: string }): Promise<FeatureRequest | null> {
  const status = patch.status && (FEATURE_STATUSES as readonly string[]).includes(patch.status) ? patch.status : null;
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `UPDATE feature_requests SET
          title = COALESCE($2, title),
          description = COALESCE($3, description),
          status = COALESCE($4, status),
          updated_at = now()
        WHERE id = $1
      RETURNING ${COLS}, (SELECT count(*)::int FROM feature_request_tickets t WHERE t.request_id = feature_requests.id) AS evidence_count`,
      [id, patch.title ?? null, patch.description ?? null, status],
    );
    return r.rowCount ? mapRow(r.rows[0] as Record<string, unknown>) : null;
  });
}

export async function deleteFeatureRequest(tenantId: string, id: string): Promise<boolean> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query("DELETE FROM feature_requests WHERE id = $1", [id]);
    return (r.rowCount ?? 0) > 0;
  });
}

/** Link a ticket as evidence for a request (idempotent). Returns false if either id is missing. */
export async function linkTicketToFeature(tenantId: string, requestId: string, ticketId: string): Promise<boolean> {
  return withTenant(tenantId, async (c) => {
    const ok = await c.query(
      `SELECT (SELECT 1 FROM feature_requests WHERE id = $1) AS r, (SELECT 1 FROM tickets WHERE id = $2) AS t`,
      [requestId, ticketId],
    );
    if (!ok.rows[0]?.r || !ok.rows[0]?.t) return false;
    await c.query(
      `INSERT INTO feature_request_tickets (tenant_id, request_id, ticket_id)
       VALUES (current_tenant(), $1, $2) ON CONFLICT DO NOTHING`,
      [requestId, ticketId],
    );
    return true;
  });
}

export async function unlinkTicketFromFeature(tenantId: string, requestId: string, ticketId: string): Promise<void> {
  await withTenant(tenantId, (c) =>
    c.query("DELETE FROM feature_request_tickets WHERE request_id = $1 AND ticket_id = $2", [requestId, ticketId]),
  );
}

/** The feature requests a given ticket is linked to (for the ticket rail). */
export async function featuresForTicket(tenantId: string, ticketId: string): Promise<{ id: string; title: string; status: string }[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT fr.id, fr.title, fr.status
         FROM feature_request_tickets frt
         JOIN feature_requests fr ON fr.id = frt.request_id AND fr.tenant_id = frt.tenant_id
        WHERE frt.ticket_id = $1 ORDER BY fr.title`,
      [ticketId],
    );
    return r.rows.map((x) => ({ id: x.id as string, title: x.title as string, status: x.status as string }));
  });
}
