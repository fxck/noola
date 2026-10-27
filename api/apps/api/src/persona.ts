import { withTenant } from "@repo/db";

// Agent persona — the tenant's assistant voice. One row per tenant sets the tone, an optional
// signature, hard guardrails, and free-form extra instructions. personaPrompt() renders it into a
// system-prompt fragment that copilot prepends to every draft/autoreply, so the AI answers sound
// like THIS team, not a generic bot. Kept deliberately small and text-only — it steers the prompt,
// it does not add tools or change retrieval.

// A short, opinionated set of tones the UI offers; free text is allowed but these steer the model
// cleanly. The value is passed through to the prompt verbatim, so any string is safe.
export const PERSONA_TONES = ["friendly", "professional", "concise", "empathetic", "playful", "formal"] as const;

export interface Persona {
  tone: string;
  signature: string;
  guardrails: string;
  instructions: string;
}

export interface PersonaPatch {
  tone?: string;
  signature?: string;
  guardrails?: string;
  instructions?: string;
}

export const DEFAULT_PERSONA: Persona = {
  tone: "friendly",
  signature: "",
  guardrails: "",
  instructions: "",
};

export async function getPersona(tenantId: string): Promise<Persona> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      "SELECT tone, signature, guardrails, instructions FROM agent_persona WHERE tenant_id = current_tenant()",
    );
    return r.rowCount ? (r.rows[0] as Persona) : DEFAULT_PERSONA;
  });
}

/** Upsert the tenant persona (partial patch; unset fields keep their current/default value). */
export async function putPersona(tenantId: string, patch: PersonaPatch): Promise<Persona> {
  const cur = await getPersona(tenantId);
  const next: Persona = {
    tone: (patch.tone ?? cur.tone).slice(0, 40),
    signature: (patch.signature ?? cur.signature).slice(0, 500),
    guardrails: (patch.guardrails ?? cur.guardrails).slice(0, 2000),
    instructions: (patch.instructions ?? cur.instructions).slice(0, 2000),
  };
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO agent_persona (tenant_id, tone, signature, guardrails, instructions, updated_at)
       VALUES (current_tenant(), $1, $2, $3, $4, now())
       ON CONFLICT (tenant_id) DO UPDATE SET
         tone = EXCLUDED.tone, signature = EXCLUDED.signature, guardrails = EXCLUDED.guardrails,
         instructions = EXCLUDED.instructions, updated_at = now()
       RETURNING tone, signature, guardrails, instructions`,
      [next.tone, next.signature, next.guardrails, next.instructions],
    );
    return r.rows[0] as Persona;
  });
}

/**
 * Render a persona into a system-prompt fragment. Empty when the persona is the pure default (so an
 * unconfigured tenant pays nothing). The fragment is additive — it steers voice on top of the
 * grounding rules, and never overrides the "ground only in sources" instruction.
 */
export function personaPrompt(p: Persona): string {
  const lines: string[] = [];
  // Only steer tone when it's been changed from the default — a pure-default persona renders empty
  // so an unconfigured tenant adds nothing to the prompt.
  if (p.tone && p.tone !== DEFAULT_PERSONA.tone) lines.push(`Write in a ${p.tone} tone.`);
  if (p.instructions.trim()) lines.push(p.instructions.trim());
  if (p.guardrails.trim()) lines.push(`Never do the following: ${p.guardrails.trim()}`);
  if (p.signature.trim()) lines.push(`Sign off exactly as:\n${p.signature.trim()}`);
  return lines.join("\n");
}

/** Convenience: fetch + render in one call for the draft path. Empty string when unconfigured. */
export async function personaFragment(tenantId: string): Promise<string> {
  const p = await getPersona(tenantId);
  return personaPrompt(p);
}
