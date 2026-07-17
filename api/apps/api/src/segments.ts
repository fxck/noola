import { withTenant } from "@repo/db";

// Saved Segments — named, reusable filter definitions over a resource (contacts for
// now). A segment stores the same filter-builder grammar the contacts directory uses
// ({ q?, filters: ContactFilterCondition[], sort? }) as an opaque `definition` jsonb, so
// the surface that owns the grammar (contacts) is the only thing that interprets it. All
// tenant-scoped through withTenant — the single isolation choke point.

export interface SegmentRow {
  id: string;
  name: string;
  resource: string;
  definition: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

const COLS = "id, name, resource, definition, created_at, updated_at";

/** List a tenant's saved segments, optionally scoped to one resource. Newest first. */
export async function listSegments(tenantId: string, resource?: string): Promise<SegmentRow[]> {
  return withTenant(tenantId, async (c) => {
    const r = resource
      ? await c.query(
          `SELECT ${COLS} FROM segments WHERE resource = $1 ORDER BY created_at DESC LIMIT 200`,
          [resource],
        )
      : await c.query(`SELECT ${COLS} FROM segments ORDER BY created_at DESC LIMIT 200`);
    return r.rows as SegmentRow[];
  });
}

export async function getSegment(tenantId: string, id: string): Promise<SegmentRow | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(`SELECT ${COLS} FROM segments WHERE id = $1`, [id]);
    return r.rowCount ? (r.rows[0] as SegmentRow) : null;
  });
}

export async function createSegment(
  tenantId: string,
  input: { name: string; resource?: string; definition: Record<string, unknown> },
): Promise<SegmentRow> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO segments (tenant_id, name, resource, definition)
       VALUES (current_tenant(), $1, COALESCE($2,'contacts'), $3::jsonb)
       RETURNING ${COLS}`,
      [input.name, input.resource ?? null, JSON.stringify(input.definition ?? {})],
    );
    return r.rows[0] as SegmentRow;
  });
}

/** Partial update: rename and/or replace the definition. Returns null if gone. */
export async function updateSegment(
  tenantId: string,
  id: string,
  patch: { name?: string; definition?: Record<string, unknown> },
): Promise<SegmentRow | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `UPDATE segments
          SET name = COALESCE($2, name),
              definition = COALESCE($3::jsonb, definition),
              updated_at = now()
        WHERE id = $1
      RETURNING ${COLS}`,
      [id, patch.name ?? null, patch.definition === undefined ? null : JSON.stringify(patch.definition)],
    );
    return r.rowCount ? (r.rows[0] as SegmentRow) : null;
  });
}

export async function deleteSegment(tenantId: string, id: string): Promise<boolean> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query("DELETE FROM segments WHERE id = $1", [id]);
    return (r.rowCount ?? 0) > 0;
  });
}
