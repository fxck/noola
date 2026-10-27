import {
  type Automation,
  type AutomationInput,
  type Action,
  type Condition,
  type AutomationTrigger,
  type TriggerConfig,
  type FlowGraph,
  type FlowNode,
} from "@/lib/automations";

// The in-editor shape of an automation. Shared by the form editor and the visual canvas so both
// authoring surfaces mutate the exact same draft (the canvas is just an alternative view over it).
export interface Draft {
  id: string | null;
  name: string;
  trigger: AutomationTrigger;
  triggerConfig: TriggerConfig;
  webhookToken: string | null;
  enabled: boolean;
  match: "all" | "any";
  conditions: Condition[];
  actions: Action[];
  // The executable DAG. `null` = a simple linear rule (form editor); non-null = a flow built on the
  // canvas, which the engine walks in place of `actions`. Committed the moment the canvas is edited.
  graph: FlowGraph | null;
}

export interface XY {
  x: number;
  y: number;
}

export function emptyDraft(): Draft {
  return {
    id: null,
    name: "",
    trigger: "message.received",
    triggerConfig: {},
    webhookToken: null,
    enabled: true,
    match: "all",
    conditions: [],
    actions: [{ type: "assign", assigneeId: null }],
    graph: null,
  };
}

// A "knowledge pipeline" starter: a Source authored as a flow — run on a schedule, fetch from a
// URL, and upsert the result into the KB. This is the Sources↔Studio bridge (Milestone 3): a Source
// IS a flow, built on the same canvas. The graph is pre-wired so the canvas opens ready to edit.
export function pipelineDraft(): Draft {
  const graph: FlowGraph = {
    nodes: [
      { id: "trigger", type: "trigger", config: withPos({}, { x: 0, y: 0 }) },
      {
        id: "action-0",
        type: "action",
        config: withPos({ action: { type: "http", method: "GET", url: "", headers: "", httpBody: "" } }, { x: COL, y: 0 }),
      },
      {
        id: "action-1",
        type: "action",
        config: withPos({ action: { type: "kb_upsert", kbTitle: "{{http.json.title}}", kbBody: "{{http.body}}" } }, { x: COL * 2, y: 0 }),
      },
    ],
    edges: [
      { from: "trigger", to: "action-0" },
      { from: "action-0", to: "action-1" },
    ],
  };
  return {
    id: null,
    name: "",
    trigger: "schedule",
    triggerConfig: { intervalMinutes: 60 },
    webhookToken: null,
    enabled: true,
    match: "all",
    conditions: [],
    actions: [],
    graph,
  };
}

export function draftFrom(a: Automation): Draft {
  return {
    id: a.id,
    name: a.name,
    trigger: a.trigger as AutomationTrigger,
    triggerConfig: a.triggerConfig ?? {},
    webhookToken: a.webhookToken ?? null,
    enabled: a.enabled,
    match: a.conditions?.match ?? "all",
    conditions: a.conditions?.conditions ?? [],
    actions: a.actions ?? [],
    graph: a.graph ?? null,
  };
}

// An AI-authored flow (dogfood L3-E2) → an editable Draft, opened for review. Always DISABLED: the
// human arms it by saving. Left as a linear draft (graph null) so the canvas derives + lays it out.
export function draftFromAuthored(a: AutomationInput): Draft {
  return {
    id: null,
    name: a.name,
    trigger: a.trigger as AutomationTrigger,
    triggerConfig: a.triggerConfig ?? {},
    webhookToken: null,
    enabled: false,
    match: a.conditions?.match ?? "all",
    conditions: a.conditions?.conditions ?? [],
    actions: a.actions ?? [],
    graph: a.graph ?? null,
  };
}

// ── graph helpers ────────────────────────────────────────────────────────────
export function nodePos(n: FlowNode): XY {
  const p = n.config?.position as XY | undefined;
  return p && typeof p.x === "number" && typeof p.y === "number" ? p : { x: 0, y: 0 };
}

export function withPos<T extends Record<string, unknown>>(config: T, pos: XY): T & { position: XY } {
  return { ...config, position: pos };
}

const COL = 320;

// Seed a graph from a linear draft so the canvas is never empty for an existing rule: the trigger
// flows into a branch (when the rule has conditions) and then down the action chain. Deterministic
// layout — same rule always derives the same positions, so an un-committed derivation is stable.
export function deriveGraph(draft: Draft): FlowGraph {
  const nodes: FlowNode[] = [];
  const edges: FlowGraph["edges"] = [];
  let col = 0;

  nodes.push({ id: "trigger", type: "trigger", config: withPos({}, { x: col * COL, y: 0 }) });
  let prev = "trigger";
  let prevWhen: "true" | "false" | undefined;

  if (draft.conditions.length > 0) {
    col += 1;
    nodes.push({
      id: "branch",
      type: "branch",
      config: withPos({ conditions: { match: draft.match, conditions: draft.conditions } }, { x: col * COL, y: 0 }),
    });
    edges.push({ from: prev, to: "branch" });
    prev = "branch";
    prevWhen = "true";
  }

  draft.actions.forEach((action, i) => {
    col += 1;
    const id = `action-${i}`;
    nodes.push({ id, type: "action", config: withPos({ action }, { x: col * COL, y: 0 }) });
    edges.push(prevWhen ? { from: prev, to: id, when: prevWhen } : { from: prev, to: id });
    prev = id;
    prevWhen = undefined;
  });

  return { nodes, edges };
}

// A rule "is a flow" once its graph carries more than a bare trigger.
export function isFlow(graph: FlowGraph | null): boolean {
  return !!graph && graph.nodes.some((n) => n.type !== "trigger");
}
