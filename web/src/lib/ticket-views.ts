import { api } from "@/lib/api";

// Saved ticket views — named filter presets for the unified Inbox/Tickets table. Persisted
// through the generic `segments` store with resource="tickets" (the same backend the contacts
// saved-segments use), so no new table is needed. The definition mirrors the /tickets query.

export interface TicketViewDefinition {
  status?: "open" | "closed" | "all";
  priority?: string; // csv of priorities
  team?: string; // team id, or "none" = no team
  assignee?: string; // user id, or "none" = unassigned
  q?: string;
  sort?: "updated_at" | "created_at" | "priority" | "sla";
  sortDir?: "asc" | "desc";
}

export interface TicketView {
  id: string;
  name: string;
  definition: TicketViewDefinition;
  created_at: string;
}

const RESOURCE = "tickets";

export async function fetchTicketViews(): Promise<TicketView[]> {
  return (await api<{ segments: TicketView[] }>(`/segments?resource=${RESOURCE}`)).segments;
}

export async function createTicketView(
  name: string,
  definition: TicketViewDefinition,
): Promise<TicketView> {
  return (
    await api<{ segment: TicketView }>("/segments", {
      method: "POST",
      body: JSON.stringify({ name, resource: RESOURCE, definition }),
    })
  ).segment;
}

export async function deleteTicketView(id: string): Promise<void> {
  await api(`/segments/${id}`, { method: "DELETE" });
}
