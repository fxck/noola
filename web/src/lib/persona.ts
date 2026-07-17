import { api } from "@/lib/api";

// Agent persona — the assistant's voice. One per tenant; it's woven into the AI draft/autoreply
// system prompt so answers sound like this team. All fields optional; the server keeps prior/default
// values for unset fields.

export interface Persona {
  tone: string;
  signature: string;
  guardrails: string;
  instructions: string;
}

export const TONES = ["friendly", "professional", "concise", "empathetic", "playful", "formal"] as const;

export async function fetchPersona(): Promise<Persona> {
  return (await api<{ persona: Persona }>("/persona")).persona;
}

export async function savePersona(patch: Partial<Persona>): Promise<Persona> {
  return (await api<{ persona: Persona }>("/persona", { method: "PUT", body: JSON.stringify(patch) })).persona;
}
