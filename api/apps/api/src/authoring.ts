import { AutomationInput } from "@repo/contracts";
import type { AutomationInput as AutomationInputType, AutomationAction } from "@repo/contracts";
import { resolveModelDriver } from "./modelconfig.js";

// AI flow authoring (dogfood L3-E2) — "describe the automation" → the tenant's model emits a typed
// flow the user reviews on the canvas, dry-runs, then arms. This is the differentiator the typed
// refactor unlocks: because every action carries a read/update effect and the whole vocabulary is
// a small typed set, a generated flow is safe to PREVIEW (dry-run) before it's ever armed. The
// generated automation is returned DISABLED — authoring proposes, the human arms.
//
// Reuses the same ModelServingDriver seam as runAgent (resolveModelDriver): a managed-baseline
// tenant with no hosted model gets an honest error, and FORCE_RULE_MODEL keeps tests model-free.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Extract the first balanced JSON object from a completion (models wrap JSON in prose/fences). */
function extractJsonObject(raw: string): unknown | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { try { return JSON.parse(raw.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

/** Sanitize model-authored actions so a hallucinated id/field can't fail the whole parse: drop
 *  non-UUID assignee/integration/collection ids (they need manual selection anyway), and force
 *  a pool assign to have no bogus single id. Exported for the deterministic test. */
export function sanitizeAuthoredActions(actions: unknown): AutomationAction[] {
  if (!Array.isArray(actions)) return [];
  const out: AutomationAction[] = [];
  for (const raw of actions) {
    if (!raw || typeof raw !== "object") continue;
    const a = { ...(raw as Record<string, unknown>) };
    for (const idField of ["assigneeId", "integrationId", "kbCollectionId"]) {
      if (a[idField] !== undefined && a[idField] !== null && !(typeof a[idField] === "string" && UUID_RE.test(a[idField] as string))) {
        a[idField] = idField === "assigneeId" ? null : undefined;
      }
    }
    // A pool strategy never uses a single assigneeId; a specific strategy with no valid id → null.
    if (a.type === "assign" && (a.strategy === "round_robin" || a.strategy === "least_loaded")) a.assigneeId = null;
    out.push(a as AutomationAction);
  }
  return out;
}

const AUTHOR_SYSTEM = [
  "You convert a plain-English support-automation request into ONE JSON automation object for a helpdesk platform (Noola).",
  "",
  "Output ONLY a JSON object with this shape — no prose, no markdown fences:",
  '{ "name": "<short name>", "trigger": "<trigger>", "conditions": { "match": "all"|"any", "conditions": [ {"field","op","value"} ] }, "actions": [ {"type", ...fields} ] }',
  "",
  "TRIGGERS (pick the one that fires the automation):",
  "- manual — no event; the flow runs only on demand (use for a run-on-a-ticket action)",
  "- ticket.created — a new ticket arrives (use for routing/triage/auto-tagging)",
  "- message.received — a customer replies on a ticket",
  "- ticket.closed — a ticket is resolved (use for surveys)",
  "- ticket.assigned — a ticket is assigned",
  "- ticket.priority_changed / ticket.tagged / ticket.type_changed — taxonomy changed",
  "- note.added — an internal note was posted",
  "- csat.received / nps.received — a satisfaction response arrived",
  "- sla.at_risk / sla.breached — a ticket is near or past its SLA target (use for escalation)",
  "- schedule — runs every N minutes (put intervalMinutes in triggerConfig)",
  "",
  "CONDITION fields: subject, body, channelType (email|discord|synthetic|widget…), authorType (customer|agent), status, priority (low|normal|high|urgent), tags (a list), assigneeId, whoseTurn.",
  "CONDITION ops: equals, not_equals, contains, not_contains, contains_any (value = comma list; matches if any overlaps — use for tags/priority), in (scalar is one of a comma list), starts_with, gt, lt, is_empty, is_not_empty.",
  "An empty conditions list means the automation runs on every event of the trigger.",
  "",
  "ACTIONS (each needs a `type` plus its fields):",
  '- {"type":"assign","strategy":"round_robin"|"least_loaded"} — auto-assign fairly across all agents. DO NOT invent an assigneeId.',
  '- {"type":"set_priority","priority":"low"|"normal"|"high"|"urgent"}',
  '- {"type":"add_tags","tags":["<tag>", ...]}',
  '- {"type":"set_status","status":"closed"|"open"}',
  '- {"type":"reply","body":"<message; use {{subject}} / {{body}} to insert ticket fields>"}',
  '- {"type":"survey","surveyKind":"csat"|"nps"|"both"} — send a satisfaction survey (once per ticket)',
  '- {"type":"rag","autoReply":true|false} — draft a grounded answer from the knowledge base (autoReply posts it)',
  '- {"type":"notify","text":"<alert>"} — alert a connector (the user picks which one afterwards)',
  '- {"type":"stop"} — for first-match routing, end after this rule',
  "",
  "RULES: always include name + a valid trigger. Prefer the simplest actions that satisfy the request. Never invent UUIDs, agent names, or integration ids — use strategy-based assign and leave connector/agent selection for the user. Keep it to a few actions.",
  "",
  "EXAMPLE — 'auto-assign new Discord tickets round robin and tag them discord':",
  '{"name":"Route Discord tickets","trigger":"ticket.created","conditions":{"match":"all","conditions":[{"field":"channelType","op":"equals","value":"discord"}]},"actions":[{"type":"add_tags","tags":["discord"]},{"type":"assign","strategy":"round_robin"}]}',
  "",
  "EXAMPLE — 'when a ticket is closed, send a CSAT survey':",
  '{"name":"CSAT on resolution","trigger":"ticket.closed","conditions":{"match":"all","conditions":[]},"actions":[{"type":"survey","surveyKind":"csat"}]}',
].join("\n");

export interface AuthorResult {
  automation?: AutomationInputType;
  error?: string;
}

/** Author an automation from a natural-language prompt. Returns a DISABLED draft (armed only after
 *  the human reviews + saves), or an error string. Never throws. */
export async function authorAutomation(tenantId: string, prompt: string): Promise<AuthorResult> {
  const clean = (prompt ?? "").trim();
  if (!clean) return { error: "Describe what the automation should do." };
  const driver = await resolveModelDriver(tenantId);
  if (typeof driver.complete !== "function") {
    return { error: "AI flow authoring needs a hosted model — connect one in Settings → Model." };
  }
  let raw: string;
  try {
    raw = await driver.complete(AUTHOR_SYSTEM, `Build a support automation for this request:\n"${clean.slice(0, 2000)}"\n\nReturn ONLY the JSON object.`);
  } catch (e) {
    return { error: `The model couldn't be reached: ${(e as Error).message.slice(0, 160)}` };
  }
  const obj = extractJsonObject(raw);
  if (!obj || typeof obj !== "object") return { error: "The model didn't return a usable flow — try rephrasing." };

  // Sanitize actions (drop hallucinated ids), force disabled, then validate against the contract.
  const candidate = {
    ...(obj as Record<string, unknown>),
    enabled: false,
    actions: sanitizeAuthoredActions((obj as Record<string, unknown>).actions),
  };
  const parsed = AutomationInput.safeParse(candidate);
  if (!parsed.success) {
    return { error: "Couldn't turn that into a valid flow — try describing it more concretely." };
  }
  return { automation: parsed.data };
}
