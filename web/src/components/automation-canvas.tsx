import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Handle,
  NodeToolbar,
  Position,
  MarkerType,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
  type NodeTypes,
  type NodeChange,
  type EdgeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Zap,
  Plus,
  PanelRight,
  Trash2,
  Copy,
  X,
  UserRound,
  CircleDot,
  MessageSquare,
  Bell,
  Terminal,
  Globe,
  Sparkles,
  GitBranch,
  Bot,
  Unplug,
  MousePointer2,
  BookOpen,
  Contact,
  Megaphone,
  Check,
  Loader2,
  CheckCircle2,
  XCircle,
  Braces,
  Download,
  MonitorPlay,
  Variable,
  Filter,
  GitMerge,
  Sigma,
  Code2,
  ExternalLink,
  Clock,
  MousePointerClick,
  Keyboard,
  ListChecks,
  ArrowLeft,
  ArrowRight,
  RotateCw,
  Camera,
  Type,
  MoveVertical,
  Wand2,
  Eye,
  ScanText,
  HelpCircle,
  Lightbulb,
  Search,
  type LucideIcon,
} from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Combobox } from "@/components/ui/combobox";
import { cn } from "@/lib/utils";
import { isDarkNow } from "@/lib/theme";
import {
  type Action,
  type ActionType,
  type Condition,
  type ConditionOp,
  type Conditions,
  type AutomationTrigger,
  type TriggerConfig,
  type FlowGraph,
  type FlowNode,
  type FlowNodeType,
  type AgentConfig,
  TRIGGERS,
  CONDITION_FIELDS,
  CONDITION_OPS,
  ACTION_TYPES,
  ACTION_EFFECTS,
  EFFECT_LABEL,
  AGENT_TOOL_TYPES,
  VALUELESS_OPS,
} from "@/lib/automations";
import { ActionFields, resetAction } from "@/components/automation-fields";
import {
  ItemFields,
  resetItemNode,
  itemKindLabel,
  itemKindSubtitle,
  itemNodeIncomplete,
  isItemBranch,
  ITEM_KINDS,
  type FlowItemKind,
  type ItemGroup,
} from "@/components/item-fields";
import { type Draft, type XY, deriveGraph, nodePos } from "@/lib/automation-draft";
import { API_URL } from "@/lib/api";

interface Opt {
  value: string;
  label: string;
}

// ── node visuals ─────────────────────────────────────────────────────────────
// Each node kind maps to an icon + a semantic accent hue (icon chip + selection ring +
// minimap). Collapsed from a ~10-hue rainbow to a restrained "Signal & Graphite" set keyed
// to what a node DOES, so the graph reads by meaning rather than decoration:
//   signal (amber, scarce)  — the trigger, the single entry signal
//   logic  (slate-blue)     — branch / control flow
//   agent  (violet)         — the one AI concept
//   support(evergreen)      — customer-facing support actions (assign / status / reply / answer)
//   data   (slate-blue)     — knowledge & contact data steps
//   code   (graphite)       — integrations, HTTP, code, field maths
const ACCENT = {
  signal: "#EFA43C",
  logic: "var(--info)",
  agent: "#7C6FB0",
  support: "#3E9B79",
  data: "var(--info)",
  code: "#6E6C64",
} as const;

// Item-node (studio library) hues, per group: data/transforms read as "info", browser steps get a
// distinct teal, AI-browser steps share the agent purple (they're model-driven).
const ITEM_GROUP_HUE: Record<ItemGroup, string> = {
  "Data & code": "var(--info)",
  Browser: "#2F8F9D",
  "AI browser": "#7C6FB0",
};
const ITEM_ICON: Record<FlowItemKind, LucideIcon> = {
  httpRequest: Globe, setVar: Variable, code: Code2, setFields: Braces, filter: Filter, merge: GitMerge,
  aggregate: Sigma, ifCond: GitBranch,
  openUrl: ExternalLink, navBack: ArrowLeft, navForward: ArrowRight, reload: RotateCw, waitFor: Clock,
  clickSelector: MousePointerClick, typeText: Type, selectOption: ListChecks, hover: MousePointer2,
  scroll: MoveVertical, pressKey: Keyboard, getText: ScanText, screenshot: Camera,
  act: Wand2, observe: Eye, extract: ScanText, agent: Bot,
};
function itemAccent(kind: string): Accent {
  const meta = ITEM_KINDS.find((m) => m.kind === kind);
  return {
    icon: ITEM_ICON[kind as FlowItemKind] ?? Braces,
    hue: meta ? ITEM_GROUP_HUE[meta.group] : "var(--info)",
    label: meta?.label ?? "Node",
  };
}

type Accent = { icon: LucideIcon; hue: string; label: string };

function actionAccent(t: ActionType | undefined): Accent {
  switch (t) {
    case "assign": return { icon: UserRound, hue: ACCENT.support, label: "Assign" };
    case "set_status": return { icon: CircleDot, hue: ACCENT.support, label: "Set status" };
    case "reply": return { icon: MessageSquare, hue: ACCENT.support, label: "Reply" };
    case "rag": return { icon: Sparkles, hue: ACCENT.support, label: "Answer (KB)" };
    case "notify": return { icon: Bell, hue: ACCENT.code, label: "Notify" };
    case "run": return { icon: Terminal, hue: ACCENT.code, label: "Run code" };
    case "http": return { icon: Globe, hue: ACCENT.code, label: "HTTP" };
    case "set_fields": return { icon: Braces, hue: ACCENT.code, label: "Set fields" };
    case "kb_upsert": return { icon: BookOpen, hue: ACCENT.data, label: "Save to KB" };
    case "contact_update": return { icon: Contact, hue: ACCENT.data, label: "Update contact" };
    case "broadcast_send": return { icon: Megaphone, hue: ACCENT.data, label: "Broadcast" };
    case "web_fetch": return { icon: Download, hue: ACCENT.data, label: "Fetch page" };
    case "browser_extract": return { icon: MonitorPlay, hue: ACCENT.data, label: "Render page" };
    default: return { icon: Zap, hue: ACCENT.support, label: "Action" };
  }
}

function nodeAccent(ntype: FlowNodeType, actionType?: ActionType, itemKind?: string): Accent {
  if (ntype === "trigger") return { icon: Zap, hue: ACCENT.signal, label: "Trigger" };
  if (ntype === "branch") return { icon: GitBranch, hue: ACCENT.logic, label: "Branch" };
  if (ntype === "agent") return { icon: Bot, hue: ACCENT.agent, label: "AI agent" };
  if (ntype === "item") return itemAccent(itemKind ?? "");
  return actionAccent(actionType);
}

// A distinguishing title for an agent node — its first instruction line, so multiple agent
// nodes read apart on the canvas (the eyebrow already says "AI agent").
function agentTitle(agent: AgentConfig): string {
  const instr = (agent.instructions ?? "").trim();
  if (!instr) return "AI agent";
  const first = instr.split("\n")[0].trim();
  return first.length > 42 ? `${first.slice(0, 42).trimEnd()}…` : first;
}

// ── per-node help + one-click example (studio parity) ───────────────────────────
// The inspector's "?" reveals what a node does (beyond its one-line desc) and, where a node has
// load-bearing config, an "Insert example" button that fills a realistic starting point so authors
// aren't staring at an empty box. `example()` returns a config patch merged onto the node.
type NodeHelp = { body: string; example?: () => Record<string, unknown>; exampleLabel?: string };

const ACTION_HELP: Partial<Record<ActionType, NodeHelp>> = {
  reply: {
    body: "Posts an agent message on the ticket. Weave in ticket context with {{subject}}, {{body}}, or an earlier step's output like {{rag.answer}}.",
    example: () => ({ action: { type: "reply", body: "Thanks for reaching out about “{{subject}}” — we're looking into it and will follow up shortly." } }),
  },
  run: {
    body: "Runs a shell command in a sandboxed runner. Reference the ticket ({{subject}}) or earlier steps ({{steps.*}}); stdout is available downstream.",
    example: () => ({ action: { type: "run", cmd: "curl -s https://api.example.com/status/{{ticketId}}" } }),
  },
  http: {
    body: "Calls any HTTP API. The response is available to later steps as {{http.status}} and {{http.json.*}} — pair with a Branch to route on the result.",
    example: () => ({ action: { type: "http", method: "POST", url: "https://api.example.com/tickets", headers: "Content-Type: application/json", httpBody: "{ \"subject\": \"{{subject}}\" }" } }),
  },
  set_fields: {
    body: "Computes values into {{vars.*}} for later steps. One key: value per line — each value is interpolated first.",
    example: () => ({ action: { type: "set_fields", setFields: "plan: {{contact.plan}}\ngreeting: Hi {{contact.name}}" } }),
  },
  kb_upsert: {
    body: "Creates or updates a knowledge-base article and indexes it for the AI to answer from. Both fields interpolate {{…}}.",
    example: () => ({ action: { type: "kb_upsert", kbTitle: "How to {{subject}}", kbBody: "{{rag.answer}}" } }),
  },
  contact_update: {
    body: "Upserts a contact keyed by email. Add one field: value per line to enrich the record from webhook/HTTP data.",
    example: () => ({ action: { type: "contact_update", contactEmail: "{{contact.email}}", contactName: "{{contact.name}}", contactFields: "plan: {{webhook.plan}}" } }),
  },
  broadcast_send: {
    body: "Composes and sends a broadcast. Leave the segment blank to send to everyone, or name a saved segment.",
    example: () => ({ action: { type: "broadcast_send", broadcastSubject: "An update on {{subject}}", broadcastBody: "Hi {{contact.name}}, here's the latest…" } }),
  },
  rag: { body: "Drafts a grounded answer from your knowledge base for the current ticket, available downstream as {{rag.answer}}. Toggle auto-reply to post it straight away." },
  notify: { body: "Sends an alert through a connector (Slack / Discord / email). Add the connector in Settings → Integrations, then pick it here." },
  web_fetch: {
    body: "Fetches a page and extracts its readable text into {{web.text}} — pair with Save to knowledge base to ingest docs. For JS-rendered SPAs, use Render a page instead.",
    example: () => ({ action: { type: "web_fetch", url: "https://docs.example.com/faq" } }),
  },
  browser_extract: {
    body: "Renders a page in a headless browser (runs JavaScript) and extracts its text into {{web.text}} — use for single-page apps that Fetch a web page returns empty.",
    example: () => ({ action: { type: "browser_extract", url: "https://app.example.com/docs" } }),
  },
};

const ITEM_HELP: Partial<Record<FlowItemKind, NodeHelp>> = {
  code: {
    body: "Transforms the flowing items in a JS sandbox: `items` (an array) comes in, return an array out. No network or filesystem access.",
    example: () => ({ code: "// tag every item, then pass them on\nreturn items.map((it) => ({ ...it, json: { ...it.json, seen: true } }));" }),
  },
  httpRequest: {
    body: "Calls any URL and flows the response on as the item. Save it to a variable to reference later as {{vars.<name>}}.",
    example: () => ({ method: "GET", url: "https://api.example.com/data", saveAs: "apiResult" }),
  },
  ifCond: {
    body: "Routes the yes / no paths on a single value. Compare an item field ({{json.*}}) or a variable against a constant.",
    example: () => ({ left: "{{json.status}}", op: "equals", right: "open" }),
  },
  setFields: {
    body: "Merges or replaces JSON onto the flowing item. Reference incoming data with {{text}} / {{json.*}}.",
    example: () => ({ fields: "{\n  \"status\": \"open\"\n}", mode: "merge" }),
  },
  setVar: {
    body: "Stores a value as vars.<name>, readable by any later step as {{vars.<name>}}.",
    example: () => ({ name: "ticketUrl", value: "{{json.url}}" }),
  },
};

function nodeHelp(node: FlowNode): NodeHelp | null {
  if (node.type === "trigger") return null; // the trigger picker already explains each option
  if (node.type === "branch") {
    return {
      body: "Splits the flow into two paths: the yes path runs when the conditions match, the no path otherwise. Leave it empty and yes always runs.",
      example: () => ({ conditions: { match: "all", conditions: [{ field: "body", op: "contains", value: "refund" }] } }),
    };
  }
  if (node.type === "agent") {
    return {
      body: "A model reads the ticket and calls the tools you grant, in a loop up to Max steps, until it's done. Needs a hosted model configured in AI & Model.",
      example: () => ({ agent: { instructions: "If it's a refund under $50, apologise and close the ticket. Otherwise assign it to a human.", tools: ["reply", "set_status", "assign"], maxSteps: 4 } }),
    };
  }
  if (node.type === "item") {
    const kind = String(node.config?.kind ?? "") as FlowItemKind;
    if (ITEM_HELP[kind]) return ITEM_HELP[kind]!;
    const meta = ITEM_KINDS.find((m) => m.kind === kind);
    return meta ? { body: meta.desc } : null;
  }
  // action
  const t = (node.config?.action as Action | undefined)?.type;
  if (t && ACTION_HELP[t]) return ACTION_HELP[t]!;
  const desc = t ? ACTION_TYPES.find((x) => x.value === t)?.desc : undefined;
  return desc ? { body: desc } : null;
}

// ── canvas context: the inline editor + mutators reach the nodes without threading
// callbacks through React Flow's node `data` (which should stay plain). ────────────
interface CanvasCtxValue {
  isAdmin: boolean;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  getNode: (id: string) => FlowNode | null;
  draft: Draft;
  assigneeOptions: Opt[];
  integrationOptions: Opt[];
  setTrigger: (t: AutomationTrigger) => void;
  setTriggerConfig: (c: TriggerConfig) => void;
  patchNodeConfig: (id: string, mutate: (c: Record<string, unknown>) => Record<string, unknown>) => void;
  removeNode: (id: string) => void;
  duplicateNode: (id: string) => void;
}
const CanvasCtx = createContext<CanvasCtxValue | null>(null);
const useCanvas = () => {
  const v = useContext(CanvasCtx);
  if (!v) throw new Error("CanvasCtx missing");
  return v;
};

// ── node card ─────────────────────────────────────────────────────────────────
// Live run state for a node while a flow executes on the canvas.
export type NodeRunStatus = "running" | "ok" | "fail";

type NodeData = {
  ntype: FlowNodeType;
  actionType?: ActionType;
  itemKind?: string;
  title: string;
  subtitle?: string;
  selected: boolean;
  unreachable: boolean;
  incomplete: boolean;
  branch: boolean;
  runStatus?: NodeRunStatus;
  runDetail?: string;
};
type AppNode = Node<NodeData>;

const HANDLE = "!h-2.5 !w-2.5 !border-2 !border-background !bg-muted-foreground/70 transition-colors";

function FlowNodeCard({ id, data }: NodeProps<AppNode>) {
  const { editingId, setEditingId } = useCanvas();
  const a = nodeAccent(data.ntype, data.actionType, data.itemKind);
  const Icon = a.icon;
  const editing = editingId === id;
  const rs = data.runStatus;
  // While a flow runs live, the node's own ring reflects its execution state (overrides the
  // selection ring): amber pulse = running, evergreen = ok, warm-red = failed.
  const runRing = rs === "running" ? ACCENT.signal : rs === "ok" ? ACCENT.support : rs === "fail" ? "#D9553F" : undefined;

  return (
    <div
      className={cn(
        "group relative w-[224px] rounded-xl border bg-card shadow-sm transition-[border-color,box-shadow]",
        runRing
          ? "border-transparent ring-2 shadow-md"
          : data.selected || editing
            ? "border-transparent ring-2 shadow-md"
            : data.unreachable
              ? "border-dashed border-amber-500/60 hover:border-amber-500"
              : "border-border hover:border-foreground/25 hover:shadow",
        rs === "running" && "animate-pulse",
      )}
      style={{ ["--tw-ring-color" as string]: runRing ?? (data.selected || editing ? a.hue : undefined) }}
      title={data.runDetail || undefined}
    >
      {rs && (
        <span className="absolute -right-2 -top-2 z-10 grid size-5 place-items-center rounded-full bg-background shadow ring-1 ring-border">
          {rs === "running" ? (
            <Loader2 className="size-3.5 animate-spin text-amber-500" />
          ) : rs === "ok" ? (
            <CheckCircle2 className="size-4 text-emerald-500" />
          ) : (
            <XCircle className="size-4 text-red-500" />
          )}
        </span>
      )}
      {data.ntype !== "trigger" && (
        <Handle type="target" position={Position.Left} className={HANDLE} />
      )}

      <div className="flex items-center gap-2.5 px-3 pt-2.5">
        <span
          className="grid size-7 shrink-0 place-items-center rounded-lg text-white shadow-sm"
          style={{ background: a.hue }}
        >
          <Icon className="size-4" strokeWidth={2.2} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-micro font-semibold uppercase tracking-wide text-muted-foreground">
            {a.label}
            {data.unreachable && (
              <span className="inline-flex items-center gap-0.5 text-amber-600 dark:text-amber-400">
                <Unplug className="size-3" /> unlinked
              </span>
            )}
          </div>
          <div className="truncate text-sm font-medium leading-tight">{data.title}</div>
        </div>
        {data.incomplete && (
          <span
            className="size-2 shrink-0 rounded-full bg-amber-500"
            title="Needs configuration"
          />
        )}
      </div>

      {data.subtitle ? (
        <div className="truncate px-3 pb-2.5 pt-1 text-xs text-muted-foreground">{data.subtitle}</div>
      ) : (
        <div className="pb-2.5" />
      )}

      {/* Live narration: while the node runs (or after a failure), surface the latest progress
          line ON the card — the browser agent's own step-by-step actions read out in real time. */}
      {data.runDetail && (rs === "running" || rs === "fail") && (
        <div
          className={cn(
            "line-clamp-2 border-t px-3 py-1.5 text-micro leading-snug",
            rs === "fail" ? "text-red-500" : "text-muted-foreground",
          )}
        >
          {data.runDetail}
        </div>
      )}

      {data.branch ? (
        <>
          <Handle id="true" type="source" position={Position.Right} style={{ top: 26 }} className={cn(HANDLE, "!bg-emerald-500")} />
          <Handle id="false" type="source" position={Position.Right} style={{ top: 48 }} className={cn(HANDLE, "!bg-muted-foreground/70")} />
          <span className="pointer-events-none absolute -right-6 top-[19px] text-[9px] font-bold text-emerald-600 dark:text-emerald-400">yes</span>
          <span className="pointer-events-none absolute -right-5 top-[41px] text-[9px] font-bold text-muted-foreground">no</span>
        </>
      ) : (
        <Handle type="source" position={Position.Right} className={HANDLE} />
      )}

      {editing && <NodeEditor id={id} onClose={() => setEditingId(null)} />}
    </div>
  );
}

const nodeTypes: NodeTypes = { flow: FlowNodeCard };

// ── labels + reachability ─────────────────────────────────────────────────────
function triggerLabel(t: string): string {
  return TRIGGERS.find((x) => x.value === t)?.label ?? t;
}
function actionLabel(t: ActionType): string {
  return ACTION_TYPES.find((x) => x.value === t)?.label ?? t;
}

// Typed-effect badge (dogfood L3-E1) — makes each action's read/update/mixed effect visible in the
// builder, so what a flow can touch is legible at a glance (a read-only flow is safe to dry-run).
const EFFECT_STYLE: Record<string, string> = {
  read: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  update: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  mixed: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  flow: "bg-muted text-muted-foreground",
};
const EFFECT_TITLE: Record<string, string> = {
  read: "Read-only — safe to preview in a dry-run",
  update: "Writes customer-visible state — suppressed in a dry-run",
  mixed: "Effect depends on config (HTTP method / auto-reply)",
  flow: "Flow control — no side effect",
};
function EffectBadge({ type }: { type: ActionType }) {
  const eff = ACTION_EFFECTS[type] ?? "update";
  return (
    <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-micro font-medium", EFFECT_STYLE[eff])} title={EFFECT_TITLE[eff]}>
      {EFFECT_LABEL[eff]}
    </span>
  );
}
function conditionsTitle(c: Conditions): string {
  if (!c || c.conditions.length === 0) return "Any time";
  return `${c.match === "any" ? "Any" : "All"} of ${c.conditions.length} condition${c.conditions.length === 1 ? "" : "s"}`;
}
function actionSubtitle(a: Action, assignees: Opt[], integrations: Opt[]): string {
  switch (a.type) {
    case "assign": return a.assigneeId ? (assignees.find((o) => o.value === a.assigneeId)?.label ?? "Assignee") : "Unassign";
    case "set_status": return a.status === "open" ? "Reopen ticket" : "Close ticket";
    case "reply": return (a.body ?? "").trim() || "No message yet";
    case "notify": return a.integrationId ? (integrations.find((o) => o.value === a.integrationId)?.label ?? "Connector") : "Pick a connector";
    case "run": return (a.cmd ?? "").trim().split("\n")[0] || "No command yet";
    case "http": return (a.url ?? "").trim() ? `${a.method ?? "GET"} ${a.url}` : "No URL yet";
    case "rag": return a.autoReply ? "Draft + auto-reply" : "Draft a grounded answer";
    case "kb_upsert": return (a.kbTitle ?? "").trim() || "No article title yet";
    case "contact_update": return (a.contactEmail ?? "").trim() || "No contact email yet";
    case "broadcast_send": return (a.broadcastSubject ?? "").trim() || "No subject yet";
    case "set_fields": { const n = (a.setFields ?? "").split("\n").filter((l) => l.includes(":")).length; return n ? `${n} field${n === 1 ? "" : "s"}` : "No fields yet"; }
    case "web_fetch": return (a.url ?? "").trim() || "No URL yet";
    case "browser_extract": return (a.url ?? "").trim() || "No URL yet";
    default: return "";
  }
}
function actionIncomplete(a: Action): boolean {
  switch (a.type) {
    case "reply": return !(a.body ?? "").trim();
    case "notify": return !a.integrationId;
    case "run": return !(a.cmd ?? "").trim();
    case "http": return !(a.url ?? "").trim();
    case "kb_upsert": return !(a.kbTitle ?? "").trim();
    case "contact_update": return !(a.contactEmail ?? "").trim();
    case "broadcast_send": return !(a.broadcastSubject ?? "").trim();
    case "set_fields": return !(a.setFields ?? "").trim();
    case "web_fetch": return !(a.url ?? "").trim();
    case "browser_extract": return !(a.url ?? "").trim();
    default: return false;
  }
}

function reachableSet(graph: FlowGraph): Set<string> {
  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    const list = adj.get(e.from) ?? [];
    list.push(e.to);
    adj.set(e.from, list);
  }
  const seen = new Set<string>(["trigger"]);
  const q = ["trigger"];
  while (q.length) {
    const id = q.shift() as string;
    for (const t of adj.get(id) ?? []) if (!seen.has(t)) { seen.add(t); q.push(t); }
  }
  return seen;
}

const edgeKey = (e: { from: string; to: string; when?: string }): string => `${e.from}::${e.when ?? ""}::${e.to}`;

// ── the canvas ────────────────────────────────────────────────────────────────
type CanvasProps = {
  draft: Draft;
  isAdmin: boolean;
  assigneeOptions: Opt[];
  integrationOptions: Opt[];
  setTrigger: (t: AutomationTrigger) => void;
  setTriggerConfig: (c: TriggerConfig) => void;
  onGraphChange: (g: FlowGraph) => void;
  // Collaborative mode: the shared Yjs graph supersedes the local draft.
  graphOverride?: FlowGraph | null;
  // Live execution overlay: per-node status while a flow runs on the canvas.
  runStatus?: Record<string, { status: NodeRunStatus; detail?: string }>;
};

export function AutomationCanvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

// Contextual cursor menu — right-clicking the pane (add a step AT the cursor), a node, or an edge.
// The Steps panel (toolbar toggle / ⌘K) is the persistent browse-all surface; the pane menu is the
// fast in-place add.
type Menu =
  | { kind: "pane"; x: number; y: number; fx: number; fy: number }
  | { kind: "node"; x: number; y: number; id: string }
  | { kind: "edge"; x: number; y: number; id: string };

function CanvasInner({ draft, isAdmin, assigneeOptions, integrationOptions, setTrigger, setTriggerConfig, onGraphChange, graphOverride, runStatus }: CanvasProps) {
  const graph = useMemo(() => graphOverride ?? draft.graph ?? deriveGraph(draft), [graphOverride, draft]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const colorMode = useAppColorMode(); // follow the app theme, not the OS
  const [nodes, setNodes, onNodesChange] = useNodesState<AppNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition, fitView } = useReactFlow();

  const structuralKey = useMemo(
    () =>
      JSON.stringify({
        n: graph.nodes.map((n) => ({ id: n.id, t: n.type, c: { ...n.config, position: undefined } })),
        e: graph.edges,
        sel: selectedId,
        edit: editingId,
        trig: draft.trigger,
        a: assigneeOptions.length,
        i: integrationOptions.length,
        rs: runStatus,
      }),
    [graph, selectedId, editingId, draft.trigger, assigneeOptions.length, integrationOptions.length, runStatus],
  );

  useEffect(() => {
    const reached = reachableSet(graph);
    // Marching-ants belong to a LIVE run only — idle edges stay static. An edge animates while it
    // sits at the running frontier (its source or target node is mid-execution).
    const runningIds = new Set(
      Object.entries(runStatus ?? {}).filter(([, v]) => v.status === "running").map(([k]) => k),
    );
    const rfNodes: AppNode[] = graph.nodes.map((n) => {
      const pos = nodePos(n);
      const action = (n.config?.action as Action | undefined) ?? undefined;
      const conditions = (n.config?.conditions as Conditions | undefined) ?? { match: "all", conditions: [] };
      const agent = (n.config?.agent as AgentConfig | undefined) ?? {};
      const rstat = runStatus?.[n.id];
      const base = {
        selected: selectedId === n.id,
        unreachable: !reached.has(n.id),
        runStatus: rstat?.status,
        runDetail: rstat?.detail,
      };
      const data: NodeData =
        n.type === "trigger"
          ? { ntype: "trigger", title: triggerLabel(draft.trigger), subtitle: TRIGGERS.find((t) => t.value === draft.trigger)?.desc, incomplete: false, branch: false, ...base, unreachable: false }
          : n.type === "branch"
            ? { ntype: "branch", title: conditionsTitle(conditions), subtitle: conditions.conditions.length ? "routes yes / no" : "always yes", incomplete: false, branch: true, ...base }
            : n.type === "agent"
              ? { ntype: "agent", title: agentTitle(agent), subtitle: `${(agent.tools ?? ["reply", "set_status"]).length} tools · ${agent.maxSteps ?? 4} steps`, incomplete: !(agent.instructions ?? "").trim(), branch: false, ...base }
              : n.type === "item"
                ? (() => {
                    const kind = String(n.config?.kind ?? "");
                    return { ntype: "item" as const, itemKind: kind, title: itemKindLabel(kind), subtitle: itemKindSubtitle(kind, n.config ?? {}), incomplete: itemNodeIncomplete(kind, n.config ?? {}), branch: isItemBranch(kind), ...base };
                  })()
                : { ntype: "action", actionType: action?.type, title: action ? actionLabel(action.type) : "Action", subtitle: action ? actionSubtitle(action, assigneeOptions, integrationOptions) : undefined, incomplete: action ? actionIncomplete(action) : true, branch: false, ...base };
      return { id: n.id, type: "flow", position: pos, data };
    });

    const rfEdges: Edge[] = graph.edges.map((e) => ({
      id: edgeKey(e),
      source: e.from,
      target: e.to,
      sourceHandle: e.when ?? undefined,
      label: e.when === "true" ? "yes" : e.when === "false" ? "no" : undefined,
      type: "smoothstep",
      animated: runningIds.has(e.from) || runningIds.has(e.to),
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      style: { strokeWidth: 1.75 },
    }));

    setNodes(rfNodes);
    setEdges(rfEdges);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structuralKey]);

  useEffect(() => {
    const t = setTimeout(() => void fitView({ padding: 0.25, duration: 200, maxZoom: 1 }), 40);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.id]);

  // ── mutators (each commits via onGraphChange) ──
  const patchNodeConfig = useCallback(
    (id: string, mutate: (c: Record<string, unknown>) => Record<string, unknown>) => {
      onGraphChange({ ...graph, nodes: graph.nodes.map((n) => (n.id === id ? { ...n, config: mutate(n.config) } : n)) });
    },
    [graph, onGraphChange],
  );

  const removeNodes = useCallback(
    (ids: string[]) => {
      const rm = new Set(ids.filter((x) => x !== "trigger"));
      if (rm.size === 0) return;
      onGraphChange({
        nodes: graph.nodes.filter((n) => !rm.has(n.id)),
        edges: graph.edges.filter((e) => !rm.has(e.from) && !rm.has(e.to)),
      });
      if (selectedId && rm.has(selectedId)) setSelectedId(null);
      if (editingId && rm.has(editingId)) setEditingId(null);
    },
    [graph, onGraphChange, selectedId, editingId],
  );

  const removeEdges = useCallback(
    (keys: string[]) => {
      const rm = new Set(keys);
      onGraphChange({ ...graph, edges: graph.edges.filter((e) => !rm.has(edgeKey(e))) });
    },
    [graph, onGraphChange],
  );

  const newNodeConfig = useCallback((kind: FlowNodeType, actionType: ActionType | undefined, itemKind: FlowItemKind | undefined, pos: XY): Record<string, unknown> => {
    if (kind === "branch") return { conditions: { match: "all", conditions: [] }, position: pos };
    if (kind === "agent") return { agent: { instructions: "", tools: ["reply", "set_status"], maxSteps: 4 }, position: pos };
    if (kind === "item") return { kind: itemKind ?? "httpRequest", ...resetItemNode(itemKind ?? "httpRequest"), position: pos };
    return { action: resetAction(actionType ?? "assign"), position: pos };
  }, []);

  const addNode = useCallback(
    (kind: FlowNodeType, actionType: ActionType | undefined, itemKind: FlowItemKind | undefined, pos: XY, openEditor = true) => {
      const id = `n_${crypto.randomUUID().slice(0, 8)}`;
      onGraphChange({ ...graph, nodes: [...graph.nodes, { id, type: kind, config: newNodeConfig(kind, actionType, itemKind, pos) }] });
      setSelectedId(id);
      if (openEditor) setEditingId(id);
    },
    [graph, onGraphChange, newNodeConfig],
  );

  const duplicateNode = useCallback(
    (id: string) => {
      const n = graph.nodes.find((x) => x.id === id);
      if (!n || n.type === "trigger") return;
      const pos = nodePos(n);
      const nid = `n_${crypto.randomUUID().slice(0, 8)}`;
      const config = { ...n.config, position: { x: pos.x + 40, y: pos.y + 60 } };
      onGraphChange({ ...graph, nodes: [...graph.nodes, { id: nid, type: n.type, config }] });
      setSelectedId(nid);
    },
    [graph, onGraphChange],
  );

  const getNode = useCallback((id: string) => graph.nodes.find((n) => n.id === id) ?? null, [graph]);

  // ── React Flow event wiring ──
  const handleNodesChange = useCallback(
    (changes: NodeChange<AppNode>[]) => {
      onNodesChange(changes);
      const removed = changes.filter((c) => c.type === "remove").map((c) => c.id);
      if (removed.length) removeNodes(removed);
    },
    [onNodesChange, removeNodes],
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      onEdgesChange(changes);
      const removed = changes.filter((c) => c.type === "remove").map((c) => c.id);
      if (removed.length) removeEdges(removed);
    },
    [onEdgesChange, removeEdges],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return;
      const when = c.sourceHandle === "true" || c.sourceHandle === "false" ? c.sourceHandle : undefined;
      const exists = graph.edges.some((e) => e.from === c.source && e.to === c.target && e.when === when);
      if (exists) return;
      onGraphChange({ ...graph, edges: [...graph.edges, { from: c.source, to: c.target, when }] });
    },
    [graph, onGraphChange],
  );

  const onNodeDragStop = useCallback(
    (_: MouseEvent | TouchEvent, node: AppNode) => {
      patchNodeConfig(node.id, (c) => ({ ...c, position: { x: Math.round(node.position.x), y: Math.round(node.position.y) } }));
    },
    [patchNodeConfig],
  );

  // right-click empty space → add-node menu (studio parity)
  const localXY = (clientX: number, clientY: number) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  };
  const openPalette = useCallback(() => {
    setMenu(null);
    setEditingId(null);
    setPaletteOpen(true);
  }, []);
  // Right-clicking empty canvas opens the add-step menu AT the cursor — the node drops exactly
  // where you clicked. (The Steps panel stays the browse/search surface, toggled from the toolbar.)
  const onPaneContextMenu = useCallback(
    (e: React.MouseEvent | MouseEvent) => {
      e.preventDefault();
      if (!isAdmin) return;
      const { x, y } = localXY(e.clientX, e.clientY);
      const flow = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      setEditingId(null);
      setMenu({ kind: "pane", x, y, fx: Math.round(flow.x), fy: Math.round(flow.y) });
    },
    [isAdmin, screenToFlowPosition],
  );
  const onNodeContextMenu = useCallback(
    (e: React.MouseEvent, node: AppNode) => {
      e.preventDefault();
      if (!isAdmin) return;
      setSelectedId(node.id);
      const { x, y } = localXY(e.clientX, e.clientY);
      setMenu({ kind: "node", x, y, id: node.id });
    },
    [isAdmin],
  );
  const onEdgeContextMenu = useCallback(
    (e: React.MouseEvent, edge: Edge) => {
      e.preventDefault();
      if (!isAdmin) return;
      const { x, y } = localXY(e.clientX, e.clientY);
      setMenu({ kind: "edge", x, y, id: edge.id });
    },
    [isAdmin],
  );

  const onPaneClick = useCallback(() => {
    setSelectedId(null);
    setEditingId(null);
    setMenu(null);
  }, []);
  const onNodeClick = useCallback((_: React.MouseEvent, node: AppNode) => {
    setMenu(null);
    setPaletteOpen(false); // the inspector opens to the node's right — don't fight the palette panel
    setSelectedId(node.id);
    setEditingId(node.id);
  }, []);

  // Add a node picked from the palette panel. The panel isn't anchored to a cursor position, so the
  // node lands in the visible canvas area (biased left of the panel) with a small per-add stagger so
  // repeated adds don't stack. Trigger picks RETYPE the root instead of adding.
  const addFromPalette = useCallback(
    (item: PaletteItem) => {
      if (item.triggerType) { setTrigger(item.triggerType); setSelectedId("trigger"); return; }
      const rect = wrapRef.current?.getBoundingClientRect();
      const flow = rect
        ? screenToFlowPosition({ x: rect.left + Math.max(120, (rect.width - 300) / 2), y: rect.top + rect.height / 2 })
        : { x: 0, y: 0 };
      const stagger = (graph.nodes.length % 6) * 26;
      addNode(item.kind, item.actionType, item.itemKind, { x: flow.x + stagger, y: flow.y + stagger }, false);
    },
    [addNode, screenToFlowPosition, setTrigger, graph.nodes.length],
  );

  // ⌘K opens the add-step palette.
  useEffect(() => {
    if (!isAdmin) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
        e.preventDefault();
        openPalette();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isAdmin, openPalette]);

  const ctx: CanvasCtxValue = {
    isAdmin,
    editingId,
    setEditingId,
    getNode,
    draft,
    assigneeOptions,
    integrationOptions,
    setTrigger,
    setTriggerConfig,
    patchNodeConfig,
    removeNode: (id) => removeNodes([id]),
    duplicateNode,
  };

  return (
    <CanvasCtx.Provider value={ctx}>
      <div ref={wrapRef} className="relative h-full w-full">
        <ReactFlow<AppNode, Edge>
          nodes={nodes}
          edges={edges}
          onNodesChange={handleNodesChange}
          onEdgesChange={handleEdgesChange}
          onConnect={onConnect}
          onNodeDragStop={onNodeDragStop}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick}
          onNodeContextMenu={onNodeContextMenu}
          onEdgeContextMenu={onEdgeContextMenu}
          onPaneContextMenu={onPaneContextMenu}
          onPaneClick={onPaneClick}
          onBeforeDelete={async ({ nodes: ns, edges: es }) => ({ nodes: ns.filter((n) => n.id !== "trigger"), edges: es })}
          deleteKeyCode={isAdmin ? ["Backspace", "Delete"] : null}
          fitView
          fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
          nodesDraggable={isAdmin}
          nodesConnectable={isAdmin}
          minZoom={0.25}
          maxZoom={1.75}
          colorMode={colorMode}
          defaultEdgeOptions={{ type: "smoothstep", animated: false, style: { strokeWidth: 1.75 } }}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.5} />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) => nodeAccent((n.data as NodeData)?.ntype, (n.data as NodeData)?.actionType, (n.data as NodeData)?.itemKind).hue}
            nodeStrokeWidth={0}
            className="!bottom-3 !right-3"
          />
        </ReactFlow>

        {/* toolbar — toggles the persistent Steps panel, top-right */}
        {isAdmin && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-end gap-2 p-3">
            <Button
              size="sm"
              variant={paletteOpen ? "outline" : "default"}
              className="pointer-events-auto shadow-sm"
              aria-pressed={paletteOpen}
              onClick={() => (paletteOpen ? setPaletteOpen(false) : openPalette())}
            >
              <PanelRight /> Steps
            </Button>
          </div>
        )}

        {/* empty state */}
        {isAdmin && graph.nodes.length <= 1 && !paletteOpen && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="flex flex-col items-center gap-2 text-center text-muted-foreground/70">
              <Sparkles className="size-7" />
              <p className="text-sm font-medium text-muted-foreground">Build your flow</p>
              <p className="text-xs">Right-click the canvas to add a step in place, or press <kbd className="rounded border bg-muted px-1 font-sans">⌘K</kbd> / open <span className="font-medium text-foreground">Steps</span> to browse.</p>
            </div>
          </div>
        )}

        {/* add-step palette — full-height right panel, searchable, all node types */}
        <PalettePanel open={paletteOpen} onClose={() => setPaletteOpen(false)} onPick={addFromPalette} trigger={draft.trigger} />

        {/* contextual menu — right-click the pane (add at cursor), a node, or an edge */}
        {menu && (
          <ContextMenu
            menu={menu}
            onClose={() => setMenu(null)}
            onNodeAction={(action, id) => {
              if (action === "edit") { setPaletteOpen(false); setSelectedId(id); setEditingId(id); }
              if (action === "duplicate") duplicateNode(id);
              if (action === "delete") removeNodes([id]);
              setMenu(null);
            }}
            onDeleteEdge={(id) => { removeEdges([id]); setMenu(null); }}
            onAddStep={(item, at) => {
              if (item.triggerType) { setTrigger(item.triggerType); setSelectedId("trigger"); }
              else addNode(item.kind, item.actionType, item.itemKind, at);
              setMenu(null);
            }}
            currentTrigger={draft.trigger}
            trigger={getNode(menu.kind === "node" ? menu.id : "") ?? undefined}
          />
        )}
      </div>
    </CanvasCtx.Provider>
  );
}

// ── context menu (pane palette / node menu / edge menu) ────────────────────────
type PaletteItem = { kind: FlowNodeType; actionType?: ActionType; itemKind?: FlowItemKind; triggerType?: AutomationTrigger; icon: LucideIcon; hue: string; label: string; desc: string };

// Trigger icons — a distinctive few, Zap as the default. Triggers all share the signal accent so the
// whole group reads as one "entry point" family.
// React Flow's colorMode="system" reads prefers-color-scheme (the OS), NOT the app's theme toggle
// (which is the `.dark` class on <html>) — so the canvas went dark on a dark OS even in the light
// app. Track the app's class reactively and drive colorMode from it, so the canvas follows the app.
function useAppColorMode(): "light" | "dark" {
  const [dark, setDark] = useState(() => (typeof document !== "undefined" ? isDarkNow() : false));
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => setDark(isDarkNow()));
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    setDark(isDarkNow());
    return () => obs.disconnect();
  }, []);
  return dark ? "dark" : "light";
}

const TRIGGER_ICON: Partial<Record<AutomationTrigger, LucideIcon>> = {
  manual: MousePointerClick,
  "message.received": MessageSquare,
  discord_slash: MessageSquare,
  slack_slash: MessageSquare,
  schedule: Clock,
  webhook: Globe,
  "csat.received": Sparkles,
  "nps.received": Sparkles,
};

// The Triggers palette group — the flow's entry point as a first-class, discoverable node. A flow has
// exactly one trigger (the undeletable root), so picking one here RETYPES that root rather than adding
// a node (wired via onSetTrigger). Derived from TRIGGERS so the vocabulary has one home.
const TRIGGER_PALETTE: { group: string; items: PaletteItem[] } = {
  group: "Triggers",
  items: TRIGGERS.map((t): PaletteItem => ({
    kind: "trigger",
    triggerType: t.value,
    icon: TRIGGER_ICON[t.value] ?? Zap,
    hue: ACCENT.signal,
    label: t.label,
    desc: t.desc,
  })),
};

// The item-node (studio library) palette groups, derived from ITEM_KINDS so the taxonomy has one home.
const ITEM_PALETTE: { group: string; items: PaletteItem[] }[] = (["Data & code", "Browser", "AI browser"] as ItemGroup[]).map((group) => ({
  group,
  items: ITEM_KINDS.filter((m) => m.group === group).map((m): PaletteItem => ({
    kind: "item",
    itemKind: m.kind,
    icon: ITEM_ICON[m.kind],
    hue: ITEM_GROUP_HUE[m.group],
    label: m.label,
    desc: m.desc,
  })),
}));

const PALETTE: { group: string; items: PaletteItem[] }[] = [
  TRIGGER_PALETTE,
  {
    group: "Logic & AI",
    items: [
      { kind: "branch", icon: GitBranch, hue: ACCENT.logic, label: "Branch", desc: "Route yes / no on a condition" },
      { kind: "agent", icon: Bot, hue: ACCENT.agent, label: "AI agent", desc: "Let a model pick actions in a loop" },
    ],
  },
  {
    group: "Support actions",
    items: [
      { kind: "action", actionType: "assign", icon: UserRound, hue: ACCENT.support, label: "Assign to agent", desc: "Route the ticket to a teammate" },
      { kind: "action", actionType: "set_status", icon: CircleDot, hue: ACCENT.support, label: "Set status", desc: "Open or close the ticket" },
      { kind: "action", actionType: "reply", icon: MessageSquare, hue: ACCENT.support, label: "Post a reply", desc: "Send an agent message" },
      { kind: "action", actionType: "rag", icon: Sparkles, hue: ACCENT.support, label: "Answer from KB", desc: "Draft a grounded answer" },
    ],
  },
  {
    group: "Knowledge & data",
    items: [
      { kind: "action", actionType: "kb_upsert", icon: BookOpen, hue: ACCENT.data, label: "Save to knowledge base", desc: "Write / update a KB article" },
      { kind: "action", actionType: "web_fetch", icon: Download, hue: ACCENT.data, label: "Fetch a web page", desc: "Extract page text → feed the KB" },
      { kind: "action", actionType: "browser_extract", icon: MonitorPlay, hue: ACCENT.data, label: "Render a page (browser)", desc: "Read a JS SPA web_fetch can't" },
      { kind: "action", actionType: "contact_update", icon: Contact, hue: ACCENT.data, label: "Update a contact", desc: "Create or enrich a contact" },
      { kind: "action", actionType: "broadcast_send", icon: Megaphone, hue: ACCENT.data, label: "Send a broadcast", desc: "Compose and send a broadcast" },
    ],
  },
  {
    group: "Integrations & code",
    items: [
      { kind: "action", actionType: "notify", icon: Bell, hue: ACCENT.code, label: "Notify a connector", desc: "Alert Slack / Discord / email" },
      { kind: "action", actionType: "http", icon: Globe, hue: ACCENT.code, label: "Call an HTTP API", desc: "Fetch or post to any URL" },
      { kind: "action", actionType: "set_fields", icon: Braces, hue: ACCENT.code, label: "Set fields", desc: "Compute values into variables" },
      { kind: "action", actionType: "run", icon: Terminal, hue: ACCENT.code, label: "Run code", desc: "Execute in a sandboxed runner" },
    ],
  },
  ...ITEM_PALETTE,
];

function ContextMenu({
  menu,
  onClose,
  onNodeAction,
  onDeleteEdge,
  onAddStep,
  currentTrigger,
  trigger,
}: {
  menu: Menu;
  onClose: () => void;
  onNodeAction: (action: "edit" | "duplicate" | "delete", id: string) => void;
  onDeleteEdge: (id: string) => void;
  onAddStep: (item: PaletteItem, at: XY) => void;
  currentTrigger: AutomationTrigger;
  trigger?: FlowNode;
}) {
  // Keep the menu on-screen: it opens down-right from the cursor, but flips
  // up / left when it would spill past the canvas edge (measured pre-paint).
  const menuRef = useRef<HTMLDivElement>(null);
  // Two-pass placement WITHOUT a visible jump: the first render is laid out but kept invisible
  // (opacity-0, no entrance) so we can measure it; useLayoutEffect then pins the flipped position +
  // origin and flips `ready`, all BEFORE the browser paints — so the entrance animation plays exactly
  // once, from the final on-screen position + correct transform-origin. (Was: rendered at the cursor,
  // animated in, THEN repositioned — which read as "sliding up from the bottom into place".)
  const [ready, setReady] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; flipY: boolean; flipX: boolean }>({
    left: Math.max(8, menu.x),
    top: Math.max(8, menu.y),
    flipY: false,
    flipX: false,
  });
  useLayoutEffect(() => {
    const el = menuRef.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!el || !parent) return;
    const flipX = menu.x + el.offsetWidth > parent.clientWidth - 8;
    const flipY = menu.y + el.offsetHeight > parent.clientHeight - 8;
    setPos({
      left: Math.max(8, flipX ? menu.x - el.offsetWidth : menu.x),
      top: Math.max(8, flipY ? menu.y - el.offsetHeight : menu.y),
      flipX,
      flipY,
    });
    setReady(true);
  }, [menu.x, menu.y, menu.kind]);
  const isTrigger = trigger?.type === "trigger";

  return (
    <>
      <div className="absolute inset-0 z-20" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        ref={menuRef}
        style={{ left: pos.left, top: pos.top }}
        className={cn(
          "absolute z-30 max-h-[70%] w-52 overflow-y-auto rounded-xl border bg-popover p-1 shadow-lg",
          // Scale + fade from the trigger corner, ~150ms ease-out. Hidden until measured so there's
          // no pre-flip flash / reposition.
          ready ? "animate-in fade-in-0 zoom-in-95 duration-150 ease-out" : "opacity-0",
          pos.flipY ? (pos.flipX ? "origin-bottom-right" : "origin-bottom-left") : pos.flipX ? "origin-top-right" : "origin-top-left",
        )}
      >
        {menu.kind === "pane" ? (
          PALETTE.map((g) => (
            <div key={g.group} className="mb-0.5">
              <div className="px-2 pb-0.5 pt-1.5 text-micro font-semibold uppercase tracking-wide text-muted-foreground">{g.group}</div>
              {g.items.map((it) => (
                <MenuRow
                  key={it.label}
                  icon={it.icon}
                  hue={it.hue}
                  label={it.label}
                  trailing={it.triggerType && it.triggerType === currentTrigger ? <Check className="size-3.5 text-emerald-500" /> : undefined}
                  onClick={() => onAddStep(it, { x: menu.fx, y: menu.fy })}
                />
              ))}
            </div>
          ))
        ) : menu.kind === "node" ? (
          <>
            <MenuRow icon={MessageSquare} hue="#6b7280" label="Edit" onClick={() => onNodeAction("edit", menu.id)} />
            {!isTrigger && <MenuRow icon={Copy} hue="#6b7280" label="Duplicate" onClick={() => onNodeAction("duplicate", menu.id)} />}
            {!isTrigger && <MenuRow icon={Trash2} hue="#ef4444" label="Delete" destructive onClick={() => onNodeAction("delete", menu.id)} />}
            {isTrigger && <div className="px-2 py-1.5 text-xs text-muted-foreground">The trigger can't be removed.</div>}
          </>
        ) : (
          <MenuRow icon={Trash2} hue="#ef4444" label="Delete connection" destructive onClick={() => onDeleteEdge(menu.id)} />
        )}
      </div>
    </>
  );
}

// ── palette panel: full-height right rail listing every node type, searchable (studio parity) ─────
// Replaces the centered add-node popover. Slides in from the right; a trigger pick RETYPES the flow's
// root, every other pick adds a node to the canvas. Stays open so several steps can be added in a row.
function PalettePanel({
  open,
  onClose,
  onPick,
  trigger,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (item: PaletteItem) => void;
  trigger: AutomationTrigger;
}) {
  const [q, setQ] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setQ("");
      // focus after the slide-in starts so the caret lands in the field
      const t = setTimeout(() => searchRef.current?.focus(), 60);
      return () => clearTimeout(t);
    }
  }, [open]);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return PALETTE;
    return PALETTE.map((g) => ({
      group: g.group,
      items: g.items.filter(
        (it) => it.label.toLowerCase().includes(needle) || it.desc.toLowerCase().includes(needle) || g.group.toLowerCase().includes(needle),
      ),
    })).filter((g) => g.items.length > 0);
  }, [q]);

  return (
    <aside
      aria-hidden={!open}
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
      className={cn(
        "absolute inset-y-0 right-0 z-30 flex w-72 flex-col border-l bg-popover shadow-xl transition-transform duration-200 ease-out",
        open ? "translate-x-0" : "pointer-events-none translate-x-full",
      )}
    >
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <span className="flex-1 text-sm font-semibold">Steps</span>
        <button className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground" onClick={onClose} aria-label="Close palette">
          <X className="size-4" />
        </button>
      </div>
      <div className="border-b p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search steps…" className="h-8 pl-8 text-sm" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {groups.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">No steps match “{q}”.</p>
        ) : (
          groups.map((g) => (
            <div key={g.group} className="mb-1">
              <div className="px-2 pb-1 pt-1.5 text-micro font-semibold uppercase tracking-wide text-muted-foreground">{g.group}</div>
              {g.items.map((it) => {
                const active = it.triggerType && it.triggerType === trigger;
                return (
                  <MenuRow
                    key={it.label}
                    icon={it.icon}
                    hue={it.hue}
                    label={it.label}
                    desc={it.desc}
                    trailing={active ? <Check className="size-3.5 text-emerald-500" /> : undefined}
                    onClick={() => onPick(it)}
                  />
                );
              })}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

function MenuRow({ icon: Icon, hue, label, desc, destructive, trailing, onClick }: { icon: LucideIcon; hue: string; label: string; desc?: string; destructive?: boolean; trailing?: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent active:scale-[0.98]", destructive && "hover:bg-destructive/10")}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", destructive && "text-destructive")} style={destructive ? undefined : { color: hue }} />
      <span className="min-w-0 flex-1">
        <span className={cn("block text-small font-medium leading-tight", destructive && "text-destructive")}>{label}</span>
        {desc && <span className="block truncate text-micro text-muted-foreground">{desc}</span>}
      </span>
      {trailing && <span className="mt-0.5 shrink-0">{trailing}</span>}
    </button>
  );
}

// ── inline node editor (anchored beside the node) ──────────────────────────────
function NodeEditor({ id, onClose }: { id: string; onClose: () => void }) {
  const { getNode, isAdmin, patchNodeConfig } = useCanvas();
  const [showHelp, setShowHelp] = useState(false);
  const node = getNode(id);
  if (!node) return null;
  const a = nodeAccent(
    node.type,
    (node.config?.action as Action | undefined)?.type,
    node.type === "item" ? String(node.config?.kind ?? "") : undefined,
  );
  const Icon = a.icon;
  const help = nodeHelp(node);

  return (
    <NodeToolbar isVisible position={Position.Right} offset={18} align="start" className="nodrag nopan nowheel">
      <div
        className="w-80 overflow-hidden rounded-xl border bg-popover shadow-xl"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
      >
        <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
          <span className="grid size-6 place-items-center rounded-md text-white" style={{ background: a.hue }}>
            <Icon className="size-3.5" strokeWidth={2.3} />
          </span>
          <span className="flex-1 truncate text-sm font-semibold">{a.label}</span>
          {help && (
            <button
              className={cn(
                "grid size-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground",
                showHelp && "bg-accent text-foreground",
              )}
              onClick={() => setShowHelp((s) => !s)}
              aria-pressed={showHelp}
              title="What does this do?"
            >
              <HelpCircle className="size-4" />
            </button>
          )}
          <button className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        {showHelp && help && (
          <div className="space-y-2 border-b bg-muted/25 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
            <p>{help.body}</p>
            {help.example && isAdmin && (
              <Button
                variant="outline"
                size="sm"
                className="h-7"
                onClick={() => { patchNodeConfig(id, (c) => ({ ...c, ...help.example!() })); setShowHelp(false); }}
              >
                <Lightbulb className="size-3.5" /> {help.exampleLabel ?? "Insert example"}
              </Button>
            )}
          </div>
        )}
        <fieldset disabled={!isAdmin} className="max-h-[60vh] overflow-y-auto p-3">
          <EditorBody id={id} node={node} onClose={onClose} />
        </fieldset>
      </div>
    </NodeToolbar>
  );
}

function EditorBody({ id, node, onClose }: { id: string; node: FlowNode; onClose: () => void }) {
  const { draft, setTrigger, setTriggerConfig, assigneeOptions, integrationOptions, patchNodeConfig, removeNode, duplicateNode } = useCanvas();

  if (node.type === "trigger") {
    return (
      <div className="space-y-2">
        <div className="text-xs font-medium text-muted-foreground">When this happens</div>
        <Combobox value={draft.trigger} onChange={(v) => setTrigger(v as AutomationTrigger)} options={TRIGGERS.map((t) => ({ value: t.value, label: t.label }))} />
        <p className="text-xs text-muted-foreground">{TRIGGERS.find((t) => t.value === draft.trigger)?.desc}</p>
        {draft.trigger === "schedule" && (
          <div className="pt-1">
            <label className="text-xs font-medium text-muted-foreground">Run every</label>
            <div className="mt-1 flex items-center gap-2">
              <Input
                type="number"
                min={1}
                className="w-24"
                value={draft.triggerConfig.intervalMinutes ?? 60}
                onChange={(e) => setTriggerConfig({ ...draft.triggerConfig, intervalMinutes: Math.max(1, Number(e.target.value) || 60) })}
              />
              <span className="text-sm text-muted-foreground">minutes</span>
            </div>
          </div>
        )}
        {draft.trigger === "webhook" && <WebhookUrl token={draft.webhookToken} />}
      </div>
    );
  }

  const footer = (
    <div className="mt-3 flex items-center gap-2 border-t pt-2.5">
      <Button variant="outline" size="sm" className="h-7" onClick={() => duplicateNode(id)}>
        <Copy className="size-3.5" /> Duplicate
      </Button>
      <div className="flex-1" />
      <Button variant="ghost" size="sm" className="h-7 text-muted-foreground hover:text-destructive" onClick={() => { removeNode(id); onClose(); }}>
        <Trash2 className="size-3.5" /> Delete
      </Button>
    </div>
  );

  if (node.type === "branch") {
    const conditions = (node.config?.conditions as Conditions | undefined) ?? { match: "all", conditions: [] };
    return (
      <div>
        <BranchEditor conditions={conditions} setConditions={(next) => patchNodeConfig(id, (c) => ({ ...c, conditions: next }))} />
        {footer}
      </div>
    );
  }

  if (node.type === "agent") {
    const agent = (node.config?.agent as AgentConfig | undefined) ?? {};
    return (
      <div>
        <AgentEditor agent={agent} setAgent={(patch) => patchNodeConfig(id, (c) => ({ ...c, agent: { ...agent, ...patch } }))} />
        {footer}
      </div>
    );
  }

  if (node.type === "item") {
    const kind = String(node.config?.kind ?? "httpRequest") as FlowItemKind;
    return (
      <div className="space-y-2">
        <div className="text-xs font-medium text-muted-foreground">{itemKindLabel(kind)}</div>
        <ItemFields
          kind={kind}
          config={node.config ?? {}}
          onChange={(patch) => patchNodeConfig(id, (c) => ({ ...c, ...patch }))}
        />
        {footer}
      </div>
    );
  }

  // action
  const action = (node.config?.action as Action | undefined) ?? { type: "assign", assigneeId: null };
  const setAction = (next: Action) => patchNodeConfig(id, (c) => ({ ...c, action: next }));
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium text-muted-foreground">Do this</div>
        <EffectBadge type={action.type} />
      </div>
      <Combobox value={action.type} onChange={(v) => setAction(resetAction(v as ActionType))} options={ACTION_TYPES.map((t) => ({ value: t.value, label: t.label }))} />
      <p className="text-xs text-muted-foreground">{ACTION_TYPES.find((t) => t.value === action.type)?.desc}</p>
      <ActionFields action={action} onChange={(patch) => setAction({ ...action, ...patch })} assigneeOptions={assigneeOptions} integrationOptions={integrationOptions} />
      {footer}
    </div>
  );
}

function BranchEditor({ conditions, setConditions }: { conditions: Conditions; setConditions: (c: Conditions) => void }) {
  const list = conditions.conditions;
  const update = (i: number, patch: Partial<Condition>) => setConditions({ ...conditions, conditions: list.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const add = () => setConditions({ ...conditions, conditions: [...list, { field: "body", op: "contains", value: "" }] });
  const remove = (i: number) => setConditions({ ...conditions, conditions: list.filter((_, j) => j !== i) });

  return (
    <div>
      <div className="mb-2 text-xs font-medium text-muted-foreground">Continue on the <span className="font-semibold text-emerald-600 dark:text-emerald-400">yes</span> path when…</div>
      {list.length > 0 && (
        <div className="mb-2 w-32">
          <Combobox value={conditions.match} onChange={(v) => setConditions({ ...conditions, match: v as "all" | "any" })} options={[{ value: "all", label: "Match all" }, { value: "any", label: "Match any" }]} />
        </div>
      )}
      {list.length === 0 ? (
        <p className="text-sm text-muted-foreground">No conditions — the <span className="font-medium text-foreground">yes</span> path always runs.</p>
      ) : (
        <ul className="space-y-2">
          {list.map((c, i) => (
            <li key={i} className="space-y-2 rounded-lg border bg-background p-2">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1"><Combobox value={c.field} onChange={(v) => update(i, { field: v })} options={CONDITION_FIELDS} /></div>
                <Button variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground hover:text-destructive" onClick={() => remove(i)} aria-label="Remove condition"><Trash2 className="size-3.5" /></Button>
              </div>
              <Combobox value={c.op} onChange={(v) => update(i, { op: v as ConditionOp })} options={CONDITION_OPS} />
              {!VALUELESS_OPS.has(c.op) && <Input placeholder="value" value={c.value} onChange={(e) => update(i, { value: e.target.value })} />}
            </li>
          ))}
        </ul>
      )}
      <Button variant="outline" size="sm" className="mt-2" onClick={add}><Plus /> Add condition</Button>
    </div>
  );
}

function AgentEditor({ agent, setAgent }: { agent: AgentConfig; setAgent: (patch: Partial<AgentConfig>) => void }) {
  const tools = agent.tools ?? ["reply", "set_status"];
  const toggleTool = (t: ActionType) => setAgent({ tools: tools.includes(t) ? tools.filter((x) => x !== t) : [...tools, t] });
  return (
    <div>
      <p className="mb-2 text-xs text-muted-foreground">A model reads the ticket and picks actions in a loop until it's done. Needs a hosted model in <span className="font-medium text-foreground">AI &amp; Model</span>.</p>
      <label className="text-xs font-medium text-muted-foreground">Instructions</label>
      <Textarea autoGrow className="mb-3 mt-1" rows={3} placeholder="e.g. If it's a refund under $50, apologise and close it. Otherwise assign to a human." value={agent.instructions ?? ""} onChange={(e) => setAgent({ instructions: e.target.value })} />
      <div className="mb-1 text-xs font-medium text-muted-foreground">Tools it can use</div>
      <div className="space-y-1.5">
        {AGENT_TOOL_TYPES.map((t) => (
          <label key={t.value} className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox className="size-3.5" checked={tools.includes(t.value)} onCheckedChange={() => toggleTool(t.value)} />
            {t.label}
          </label>
        ))}
      </div>
      <label className="mt-3 block text-xs font-medium text-muted-foreground">Max steps</label>
      <Input type="number" min={1} max={8} className="mt-1 w-24" value={agent.maxSteps ?? 4} onChange={(e) => setAgent({ maxSteps: Math.min(8, Math.max(1, Number(e.target.value) || 4)) })} />
      <label className="mt-3 block text-xs font-medium text-muted-foreground">Model <span className="font-normal">(optional)</span></label>
      <Input
        className="mt-1"
        placeholder="Workspace default"
        value={agent.model ?? ""}
        onChange={(e) => setAgent({ model: e.target.value })}
      />
      <p className="mt-1 text-micro text-muted-foreground">Override the model just for this node — e.g. a cheaper model to triage, a stronger one to draft. Uses your hosted provider &amp; key; blank keeps the workspace default.</p>
    </div>
  );
}

function WebhookUrl({ token }: { token: string | null }) {
  const [copied, setCopied] = useState(false);
  if (!token) {
    return <p className="pt-1 text-xs text-muted-foreground">Save the flow to generate its webhook URL.</p>;
  }
  const url = `${API_URL}/hooks/${token}`;
  return (
    <div className="pt-1">
      <label className="text-xs font-medium text-muted-foreground">POST here to fire the flow</label>
      <div className="mt-1 flex items-center gap-1.5">
        <code className="min-w-0 flex-1 truncate rounded-md border bg-muted px-2 py-1.5 font-mono text-micro">{url}</code>
        <button
          type="button"
          className="grid size-8 shrink-0 place-items-center rounded-md border hover:bg-accent"
          onClick={() => { void navigator.clipboard?.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
          aria-label="Copy webhook URL"
        >
          {copied ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}
        </button>
      </div>
      <p className="mt-1 text-micro text-muted-foreground">The JSON body is available to steps as <code className="rounded bg-muted px-1">{"{{webhook.*}}"}</code>.</p>
    </div>
  );
}
