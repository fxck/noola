import { withTenant } from "@repo/db";

// Macros / canned responses — reusable reply snippets a team inserts into the composer.
// Tenant-scoped through withTenant (the single isolation choke point), FORCE RLS underneath.

export interface MacroRow {
  id: string;
  name: string;
  body: string;
  shortcut: string | null;
  created_at: string;
  updated_at: string;
}

const COLS = "id, name, body, shortcut, created_at, updated_at";

export async function listMacros(tenantId: string): Promise<MacroRow[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(`SELECT ${COLS} FROM macros ORDER BY created_at DESC LIMIT 500`);
    return r.rows as MacroRow[];
  });
}

export async function createMacro(
  tenantId: string,
  input: { name: string; body: string; shortcut?: string | null },
): Promise<MacroRow> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO macros (tenant_id, name, body, shortcut)
       VALUES (current_tenant(), $1, $2, $3)
       RETURNING ${COLS}`,
      [input.name, input.body, input.shortcut ?? null],
    );
    return r.rows[0] as MacroRow;
  });
}

/** Partial update: rename / re-body / re-shortcut. Returns null if gone. */
export async function updateMacro(
  tenantId: string,
  id: string,
  patch: { name?: string; body?: string; shortcut?: string | null },
): Promise<MacroRow | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `UPDATE macros
          SET name = COALESCE($2, name),
              body = COALESCE($3, body),
              shortcut = CASE WHEN $4::boolean THEN $5 ELSE shortcut END,
              updated_at = now()
        WHERE id = $1
      RETURNING ${COLS}`,
      [id, patch.name ?? null, patch.body ?? null, patch.shortcut !== undefined, patch.shortcut ?? null],
    );
    return r.rowCount ? (r.rows[0] as MacroRow) : null;
  });
}

export async function deleteMacro(tenantId: string, id: string): Promise<boolean> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query("DELETE FROM macros WHERE id = $1", [id]);
    return (r.rowCount ?? 0) > 0;
  });
}
