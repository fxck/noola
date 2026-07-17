import { withTenant } from "@repo/db";

// Custom fields — tenant-defined ticket attributes. `custom_field_defs` is the schema the
// tenant controls; `ticket_custom_values` holds per-ticket values (stored as text, typed by
// the def). Everything RLS-scoped. Keys are slugged so integrations can address them stably.

export type CustomFieldType = "text" | "number" | "select" | "boolean" | "date";

export interface CustomFieldDef {
  id: string;
  key: string;
  label: string;
  field_type: CustomFieldType;
  options: string[];
  position: number;
  created_at: string;
  /** Which record the field describes: 'ticket' (default) or 'company' (0090). */
  entity: string;
}

const DEF_COLS = `id, key, label, field_type, options, position, created_at, entity`;

/** Slug a label into a stable key (lowercase, underscores, alnum). Falls back to "field". */
export function slugKey(label: string): string {
  const s = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s || "field";
}

export async function listFieldDefs(tenantId: string, entity?: string): Promise<CustomFieldDef[]> {
  return withTenant(tenantId, async (c) => {
    const r = entity
      ? await c.query(`SELECT ${DEF_COLS} FROM custom_field_defs WHERE entity = $1 ORDER BY position, created_at`, [entity])
      : await c.query(`SELECT ${DEF_COLS} FROM custom_field_defs ORDER BY position, created_at`);
    return r.rows as CustomFieldDef[];
  });
}

export async function createFieldDef(
  tenantId: string,
  input: { label: string; fieldType: CustomFieldType; options?: string[]; key?: string; entity?: string },
): Promise<CustomFieldDef> {
  return withTenant(tenantId, async (c) => {
    const posR = await c.query(`SELECT COALESCE(max(position), -1) + 1 AS next FROM custom_field_defs`);
    const position = Number(posR.rows[0].next) || 0;
    const key = slugKey(input.key || input.label);
    const entity = input.entity === "company" ? "company" : "ticket";
    const r = await c.query(
      `INSERT INTO custom_field_defs (tenant_id, key, label, field_type, options, position, entity)
       VALUES (current_tenant(), $1, $2, $3, $4::text[], $5, $6)
       RETURNING ${DEF_COLS}`,
      [key, input.label, input.fieldType, input.options ?? [], position, entity],
    );
    return r.rows[0] as CustomFieldDef;
  });
}

export async function updateFieldDef(
  tenantId: string,
  id: string,
  patch: { label?: string; options?: string[]; position?: number },
): Promise<CustomFieldDef | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `UPDATE custom_field_defs
          SET label = COALESCE($2, label),
              options = COALESCE($3::text[], options),
              position = COALESCE($4, position)
        WHERE id = $1
        RETURNING ${DEF_COLS}`,
      [id, patch.label ?? null, patch.options ?? null, patch.position ?? null],
    );
    return (r.rows[0] as CustomFieldDef) ?? null;
  });
}

export async function deleteFieldDef(tenantId: string, id: string): Promise<boolean> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(`DELETE FROM custom_field_defs WHERE id = $1`, [id]);
    return (r.rowCount ?? 0) > 0;
  });
}

/** A ticket's custom values as a {fieldId: value} map (only non-empty values are stored). */
export async function getTicketValues(
  tenantId: string,
  ticketId: string,
): Promise<Record<string, string>> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT field_id, value FROM ticket_custom_values WHERE ticket_id = $1`,
      [ticketId],
    );
    const out: Record<string, string> = {};
    for (const row of r.rows) out[row.field_id as string] = row.value as string;
    return out;
  });
}

/** Upsert one field's value on a ticket. Empty string clears it. Returns false if the ticket
 *  or field isn't visible (the composite FKs would reject it anyway — we check first to 404). */
export async function setTicketValue(
  tenantId: string,
  ticketId: string,
  fieldId: string,
  value: string,
): Promise<boolean> {
  return withTenant(tenantId, async (c) => {
    const ok = await c.query(`SELECT 1 FROM tickets WHERE id = $1`, [ticketId]);
    if (!ok.rowCount) return false;
    const def = await c.query(`SELECT 1 FROM custom_field_defs WHERE id = $1`, [fieldId]);
    if (!def.rowCount) return false;
    if (value.trim() === "") {
      await c.query(`DELETE FROM ticket_custom_values WHERE ticket_id = $1 AND field_id = $2`, [
        ticketId,
        fieldId,
      ]);
      return true;
    }
    await c.query(
      `INSERT INTO ticket_custom_values (tenant_id, ticket_id, field_id, value)
       VALUES (current_tenant(), $1, $2, $3)
       ON CONFLICT (tenant_id, ticket_id, field_id)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [ticketId, fieldId, value],
    );
    return true;
  });
}

// ---- Company custom values (0090) — mirrors the ticket value surface --------

export async function listCompanyCustomValues(tenantId: string, companyId: string): Promise<Record<string, string>> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(`SELECT field_id, value FROM company_custom_values WHERE company_id = $1`, [companyId]);
    return Object.fromEntries((r.rows as Array<{ field_id: string; value: string }>).map((x) => [x.field_id, x.value]));
  });
}

/** Upsert the given fields; an empty-string value clears (deletes) the row. */
export async function putCompanyCustomValues(
  tenantId: string,
  companyId: string,
  values: Record<string, string>,
): Promise<Record<string, string>> {
  await withTenant(tenantId, async (c) => {
    for (const [fieldId, value] of Object.entries(values)) {
      if (value === "") {
        await c.query(`DELETE FROM company_custom_values WHERE company_id = $1 AND field_id = $2`, [companyId, fieldId]);
      } else {
        await c.query(
          `INSERT INTO company_custom_values (tenant_id, company_id, field_id, value)
           VALUES (current_tenant(), $1, $2, $3)
           ON CONFLICT (tenant_id, company_id, field_id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [companyId, fieldId, value],
        );
      }
    }
  });
  return listCompanyCustomValues(tenantId, companyId);
}
