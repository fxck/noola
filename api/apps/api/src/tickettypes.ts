import { withTenant } from "@repo/db";

// Ticket types — a tenant-defined taxonomy (Bug / Question / Billing / …). Admin-managed
// definitions; a ticket's type is set via PATCH /tickets/:id (agent-level). RLS-scoped.

export interface TicketType {
  id: string;
  name: string;
  color: string;
  position: number;
  created_at: string;
}

// The palette the type picker offers — a small named set the UI maps to token classes.
export const TYPE_COLORS = ["slate", "blue", "green", "amber", "red", "violet", "pink", "cyan"] as const;
export type TypeColor = (typeof TYPE_COLORS)[number];

const COLS = `id, name, color, position, created_at`;

export async function listTicketTypes(tenantId: string): Promise<TicketType[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(`SELECT ${COLS} FROM ticket_types ORDER BY position, name`);
    return r.rows as TicketType[];
  });
}

export async function createTicketType(
  tenantId: string,
  input: { name: string; color?: string },
): Promise<TicketType> {
  return withTenant(tenantId, async (c) => {
    const posR = await c.query(`SELECT COALESCE(max(position), -1) + 1 AS next FROM ticket_types`);
    const position = Number(posR.rows[0].next) || 0;
    const color = (TYPE_COLORS as readonly string[]).includes(input.color ?? "") ? input.color : "slate";
    const r = await c.query(
      `INSERT INTO ticket_types (tenant_id, name, color, position)
       VALUES (current_tenant(), $1, $2, $3) RETURNING ${COLS}`,
      [input.name, color, position],
    );
    return r.rows[0] as TicketType;
  });
}

export async function updateTicketType(
  tenantId: string,
  id: string,
  patch: { name?: string; color?: string; position?: number },
): Promise<TicketType | null> {
  const color =
    patch.color !== undefined && (TYPE_COLORS as readonly string[]).includes(patch.color)
      ? patch.color
      : null;
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `UPDATE ticket_types
          SET name = COALESCE($2, name),
              color = COALESCE($3, color),
              position = COALESCE($4, position)
        WHERE id = $1 RETURNING ${COLS}`,
      [id, patch.name ?? null, color, patch.position ?? null],
    );
    return (r.rows[0] as TicketType) ?? null;
  });
}

export async function deleteTicketType(tenantId: string, id: string): Promise<boolean> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(`DELETE FROM ticket_types WHERE id = $1`, [id]);
    return (r.rowCount ?? 0) > 0;
  });
}
