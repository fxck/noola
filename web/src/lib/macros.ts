import { api } from "@/lib/api";

// Macros / canned responses — reusable reply snippets inserted into the composer.

export interface Macro {
  id: string;
  name: string;
  body: string;
  shortcut: string | null;
  created_at: string;
  updated_at: string;
}

export async function fetchMacros(): Promise<Macro[]> {
  return (await api<{ macros: Macro[] }>("/macros")).macros;
}

export async function createMacro(input: {
  name: string;
  body: string;
  shortcut?: string | null;
}): Promise<Macro> {
  return (await api<{ macro: Macro }>("/macros", { method: "POST", body: JSON.stringify(input) })).macro;
}

export async function updateMacro(
  id: string,
  patch: { name?: string; body?: string; shortcut?: string | null },
): Promise<Macro> {
  return (await api<{ macro: Macro }>(`/macros/${id}`, { method: "PATCH", body: JSON.stringify(patch) })).macro;
}

export async function deleteMacro(id: string): Promise<void> {
  await api<{ ok: true }>(`/macros/${id}`, { method: "DELETE" });
}
