import { api } from "@/lib/api";

// Ticket types — tenant-defined taxonomy. Admin-managed defs; a ticket's type is set via
// patchTicket({ typeId }). Colors are a small named palette mapped to token classes in the UI.

export const TYPE_COLORS = ["slate", "blue", "green", "amber", "red", "violet", "pink", "cyan"] as const;
export type TypeColor = (typeof TYPE_COLORS)[number];

export interface TicketType {
  id: string;
  name: string;
  color: string;
  position: number;
  created_at: string;
}

/** Tailwind classes for a type chip, by color name. Falls back to slate. Uses the
 *  same bordered + subtle-fill recipe as PRIORITY_META chips (a border, a ~10 percent
 *  tint, and readable text) so every chip in the app reads as one family — never a raw
 *  full-saturation swatch that looks like a highlighter next to the graphite theme. */
export function typeChipClass(color: string | null | undefined): string {
  const map: Record<string, string> = {
    slate: "border-border bg-muted text-muted-foreground",
    blue: "border-blue-500/25 bg-blue-500/10 text-blue-700 dark:text-blue-300",
    green: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    amber: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    red: "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300",
    violet: "border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300",
    pink: "border-pink-500/25 bg-pink-500/10 text-pink-700 dark:text-pink-300",
    cyan: "border-cyan-500/25 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
  };
  return map[color ?? "slate"] ?? map.slate;
}

/** Solid dot swatch for a type color — used by the rail's popover picker rows,
 *  where a 8px dot (not a chip) carries the color. */
export function typeDotClass(color: string | null | undefined): string {
  const map: Record<string, string> = {
    slate: "bg-muted-foreground/50",
    blue: "bg-blue-500",
    green: "bg-emerald-500",
    amber: "bg-amber-500",
    red: "bg-red-500",
    violet: "bg-violet-500",
    pink: "bg-pink-500",
    cyan: "bg-cyan-500",
  };
  return map[color ?? "slate"] ?? map.slate;
}

export async function fetchTicketTypes(): Promise<TicketType[]> {
  return (await api<{ types: TicketType[] }>("/ticket-types")).types;
}

export async function createTicketType(input: { name: string; color?: TypeColor }): Promise<TicketType> {
  return (await api<{ type: TicketType }>("/ticket-types", { method: "POST", body: JSON.stringify(input) })).type;
}

export async function updateTicketType(
  id: string,
  patch: { name?: string; color?: TypeColor; position?: number },
): Promise<TicketType> {
  return (await api<{ type: TicketType }>(`/ticket-types/${id}`, { method: "PATCH", body: JSON.stringify(patch) })).type;
}

export async function deleteTicketType(id: string): Promise<void> {
  await api<{ ok: true }>(`/ticket-types/${id}`, { method: "DELETE" });
}
