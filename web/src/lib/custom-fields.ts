import { api } from "@/lib/api";

// Custom fields — tenant-defined ticket attributes. Definitions are admin-managed; a ticket's
// values are read/written by agents. Values are a flat {fieldId: string} map.

export type CustomFieldType = "text" | "number" | "select" | "boolean" | "date";
export const CUSTOM_FIELD_TYPES: CustomFieldType[] = ["text", "number", "select", "boolean", "date"];

export interface CustomFieldDef {
  id: string;
  key: string;
  label: string;
  field_type: CustomFieldType;
  options: string[];
  position: number;
  created_at: string;
  /** 'ticket' (default) or 'company'. */
  entity: string;
}

export async function fetchFieldDefs(entity?: "ticket" | "company"): Promise<CustomFieldDef[]> {
  const q = entity ? `?entity=${entity}` : "";
  return (await api<{ fields: CustomFieldDef[] }>(`/custom-fields${q}`)).fields;
}

export async function createFieldDef(input: {
  label: string;
  fieldType: CustomFieldType;
  options?: string[];
  entity?: "ticket" | "company";
}): Promise<CustomFieldDef> {
  return (
    await api<{ field: CustomFieldDef }>("/custom-fields", {
      method: "POST",
      body: JSON.stringify(input),
    })
  ).field;
}

export async function updateFieldDef(
  id: string,
  patch: { label?: string; options?: string[]; position?: number },
): Promise<CustomFieldDef> {
  return (
    await api<{ field: CustomFieldDef }>(`/custom-fields/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    })
  ).field;
}

export async function deleteFieldDef(id: string): Promise<void> {
  await api<{ ok: true }>(`/custom-fields/${id}`, { method: "DELETE" });
}

export async function fetchTicketValues(ticketId: string): Promise<Record<string, string>> {
  return (await api<{ values: Record<string, string> }>(`/tickets/${ticketId}/custom-values`)).values;
}

export async function setTicketValue(
  ticketId: string,
  fieldId: string,
  value: string,
): Promise<void> {
  await api<{ ok: true }>(`/tickets/${ticketId}/custom-values`, {
    method: "PUT",
    body: JSON.stringify({ fieldId, value }),
  });
}
