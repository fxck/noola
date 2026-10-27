import type { AutomationAction, FlowGraph } from "@repo/contracts";

// ── Tool registry + RBAC-by-effect (dogfood L0-F1 / L3-E3) ────────────────────
// ONE source of truth for every agent/automation tool + its effect. Replaces the two lists that
// used to drift (AGENT_TOOLS names vs the SIDE_EFFECTING set): the dry-run gate AND the UI tool
// catalog both derive from here.
//   effect 'read'   — pure/compute, no external mutation; ALWAYS runs (even under dry-run).
//   effect 'update' — mutates customer-visible / external state; SUPPRESSED under dry-run.
//   effect 'mixed'  — depends on config: `http` (GET reads, write verbs mutate), `rag` (the draft
//                     is a read; its optional autoReply mutates and self-guards internally).
export type ToolEffect = "read" | "update" | "mixed";
export interface ToolMeta { effect: ToolEffect; label: string; }
export const TOOL_REGISTRY: Record<string, ToolMeta> = {
  reply: { effect: "update", label: "Reply to the customer" },
  set_status: { effect: "update", label: "Set ticket status" },
  assign: { effect: "update", label: "Assign the ticket" },
  notify: { effect: "update", label: "Notify a connector" },
  run: { effect: "update", label: "Run a sandboxed command" },
  http: { effect: "mixed", label: "HTTP request" },
  rag: { effect: "mixed", label: "Draft a grounded answer" },
  kb_upsert: { effect: "update", label: "Create a KB article" },
  contact_update: { effect: "update", label: "Upsert a contact" },
  broadcast_send: { effect: "update", label: "Send a broadcast" },
  set_fields: { effect: "read", label: "Compute values into vars" },
  web_fetch: { effect: "read", label: "Fetch a web page" },
  browser_extract: { effect: "read", label: "Render a page (browser)" },
  // Dogfood L1 — ticket-mutation tools. (`stop` is deliberately NOT here: it is flow control, not
  // a tool — keeping it out of the registry keeps it out of the agent tool vocabulary + catalog.)
  set_priority: { effect: "update", label: "Set ticket priority" },
  add_tags: { effect: "update", label: "Add ticket tags" },
  // Auto-tagging (config-driven): apply the keyword tag-rules table; AI classifier. Both mutate the
  // ticket taxonomy → `update` (suppressed under dry-run).
  apply_tag_rules: { effect: "update", label: "Apply tag rules" },
  ai_tag: { effect: "update", label: "AI auto-tag" },
  survey: { effect: "update", label: "Send a satisfaction survey" },
  escalate: { effect: "update", label: "Escalate the ticket" },
};

// The minimum role a PRINCIPAL needs to MANUALLY run a flow, derived from the strongest effect any
// of its actions can produce. Mirrors the HTTP floor's spirit at tool granularity: reads are
// viewer+, ticket/data mutations agent+, externally side-effecting "mixed" tools (http/rag) admin+.
// Automatic triggers have no principal and run as the system (unchanged) — this gates the manual
// execute/test/agent-run entrypoints only. Fail-safe throughout: an unknown tool ranks as a write.
const EFFECT_RANK: Record<ToolEffect, number> = { read: 0, update: 1, mixed: 2 };
export const EFFECT_MIN_ROLE: Record<ToolEffect, "viewer" | "agent" | "admin"> = {
  read: "viewer",
  update: "agent",
  mixed: "admin",
};

export function effectOf(actionType: string): ToolEffect {
  return TOOL_REGISTRY[actionType]?.effect ?? "update";
}

// ── Item-node registry (Studio→Studio fold) ─────────────────────────────────────
// The parallel catalog for `type:"item"` nodes (config.kind selects the studio node kind). Same
// effect semantics as TOOL_REGISTRY: read=viewer, update=agent, mixed(httpRequest)=admin; `browser`
// marks kinds that must run in the flow-runner container. `flowEffect` folds these into a flow's
// required role and `itemNodeSuppressed` gates them under dry-run — SKIPPING either fold silently
// misclassifies every item node. Unlisted kind → fail-safe update/suppress.
export const ITEM_NODE_REGISTRY: Record<string, { effect: ToolEffect; browser: boolean; label: string }> = {
  httpRequest: { effect: "mixed", browser: false, label: "HTTP request" },
  setVar: { effect: "read", browser: false, label: "Set variable" },
  setFields: { effect: "read", browser: false, label: "Edit fields" },
  filter: { effect: "read", browser: false, label: "Filter" },
  merge: { effect: "read", browser: false, label: "Merge" },
  aggregate: { effect: "read", browser: false, label: "Aggregate" },
  ifCond: { effect: "read", browser: false, label: "If" },
  code: { effect: "update", browser: false, label: "Code" }, // fail-safe: suppressed in dry-run
  openUrl: { effect: "read", browser: true, label: "Open URL" },
  navBack: { effect: "read", browser: true, label: "Navigate back" },
  navForward: { effect: "read", browser: true, label: "Navigate forward" },
  reload: { effect: "read", browser: true, label: "Reload" },
  waitFor: { effect: "read", browser: true, label: "Wait for" },
  clickSelector: { effect: "update", browser: true, label: "Click" },
  typeText: { effect: "update", browser: true, label: "Type" },
  selectOption: { effect: "update", browser: true, label: "Select option" },
  hover: { effect: "read", browser: true, label: "Hover" },
  scroll: { effect: "read", browser: true, label: "Scroll" },
  pressKey: { effect: "update", browser: true, label: "Press key" },
  getText: { effect: "read", browser: true, label: "Get text" },
  screenshot: { effect: "read", browser: true, label: "Screenshot" },
  act: { effect: "update", browser: true, label: "Act (AI)" },
  observe: { effect: "read", browser: true, label: "Observe (AI)" },
  extract: { effect: "read", browser: true, label: "Extract (AI)" },
  agent: { effect: "update", browser: true, label: "Browser agent" },
};

/** The effect an `item` node produces, for `flowEffect`. Unlisted → fail-safe `update`. */
export function itemNodeEffect(kind: string | undefined): ToolEffect {
  return ITEM_NODE_REGISTRY[kind ?? ""]?.effect ?? "update";
}

/** True when an `item` node must be SUPPRESSED under dry-run (companion to `dryRunSuppressed`).
 *  read→run, update→suppress, mixed(httpRequest)→method-sensitive (write verbs suppress).
 *  Unlisted kind → suppress (fail-safe). */
export function itemNodeSuppressed(kind: string, config: Record<string, unknown>): boolean {
  const meta = ITEM_NODE_REGISTRY[kind];
  if (!meta) return true;
  if (meta.effect === "read") return false;
  if (meta.effect === "update") return true;
  if (kind === "httpRequest") {
    const m = String(config?.method ?? "GET").toUpperCase();
    return m !== "GET" && m !== "HEAD";
  }
  return false;
}

function maxEffect(a: ToolEffect, b: ToolEffect): ToolEffect {
  return EFFECT_RANK[a] >= EFFECT_RANK[b] ? a : b;
}

/** The strongest effect an ad-hoc agent's tool set can produce (defaults mirror runAgent's). */
export function agentToolsEffect(tools?: string[]): ToolEffect {
  const list = tools?.length ? tools : ["reply", "set_status"];
  return list.reduce<ToolEffect>((m, t) => maxEffect(m, effectOf(t)), "read");
}

/** The strongest effect a stored automation can produce across its linear actions, graph action
 *  nodes, and any agent node's allowed tools — the basis for RBAC-by-effect on manual runs. */
export function flowEffect(a: { actions?: AutomationAction[]; graph?: FlowGraph | null }): ToolEffect {
  let eff: ToolEffect = "read";
  for (const act of a.actions ?? []) eff = maxEffect(eff, effectOf(act.type));
  for (const node of a.graph?.nodes ?? []) {
    if (node.type === "action") {
      const act = node.config?.action as AutomationAction | undefined;
      if (act?.type) eff = maxEffect(eff, effectOf(act.type));
    } else if (node.type === "agent") {
      const cfg = node.config?.agent as { tools?: string[] } | undefined;
      eff = maxEffect(eff, agentToolsEffect(cfg?.tools));
    } else if (node.type === "item") {
      // Fold the item node's effect (Studio→Studio fold); an httpRequest folds to `mixed` → admin.
      eff = maxEffect(eff, itemNodeEffect(node.config?.kind as string | undefined));
    }
  }
  return eff;
}

/** True when an action must be SUPPRESSED under dry-run (it would mutate external/customer state).
 *  Derived from TOOL_REGISTRY; `http` is method-sensitive (this is the fix for a live POST/PUT/DELETE
 *  firing during a canvas dry-run); `rag` runs (its draft is a read) and self-guards its autoReply.
 *  Unknown tool → suppress (fail-safe: never run an unclassified effect under dry-run). */
export function dryRunSuppressed(action: AutomationAction): boolean {
  // `stop` is flow control (not in the registry): it must ALWAYS run so a dry-run shows where the
  // rule halts and first-match routing is visible.
  if (action.type === "stop") return false;
  const meta = TOOL_REGISTRY[action.type];
  if (!meta) return true;
  if (meta.effect === "update") return true;
  if (meta.effect === "read") return false;
  if (action.type === "http") {
    const m = (action.method ?? "GET").toUpperCase();
    return m !== "GET" && m !== "HEAD";
  }
  return false; // rag + any other mixed: run, self-guard internally
}
