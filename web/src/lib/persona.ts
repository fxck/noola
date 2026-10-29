import { api } from "@/lib/api";

// Agent persona — the assistant's voice. One per tenant; it's woven into the AI draft/autoreply
// system prompt so answers sound like this team. All fields optional; the server keeps prior/default
// values for unset fields.

export interface Persona {
  tone: string;
  signature: string;
  guardrails: string;
  instructions: string;
  /** When the AI helps and when it hands off. Null uses the default rules. */
  handoffRules: string | null;
}

/** The fixed parts of the prompt the AI answers with, for showing the whole prompt. */
export interface DraftPrompt {
  /** The saved persona as the model reads it. */
  persona: string;
  always: string;
  answerForms: string;
  noSources: string;
}

export interface PersonaSettings {
  persona: Persona;
  defaultHandoffRules: string;
  prompt: DraftPrompt;
}

export const HANDOFF_RULES_MAX = 4000;

export const TONES = ["friendly", "professional", "concise", "empathetic", "playful", "formal"] as const;

export async function fetchPersona(): Promise<PersonaSettings> {
  return api<PersonaSettings>("/persona");
}

export async function savePersona(patch: Partial<Persona>): Promise<Persona> {
  return (await api<{ persona: Persona }>("/persona", { method: "PUT", body: JSON.stringify(patch) })).persona;
}
