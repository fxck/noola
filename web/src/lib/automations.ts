import { api, API_URL, getToken } from "@/lib/api";

// Client for the automations (rules) engine API (Agent Studio). A rule is
// WHEN <trigger> IF <conditions> THEN <actions>. List/get/runs are viewer+; authoring and
// dry-run are admin-gated (a 403 ApiError surfaces for non-admins).

export type AutomationTrigger =
  | "manual"
  | "ticket.created" | "message.received" | "ticket.closed" | "ticket.assigned"
  | "schedule" | "webhook"
  | "ticket.priority_changed" | "ticket.tagged" | "ticket.type_changed"
  | "note.added" | "csat.received" | "nps.received"
  | "sla.breached" | "sla.at_risk"
  | "discord_slash" | "slack_slash"
  | "source.synced";
export type ConditionOp =
  | "equals" | "not_equals" | "contains" | "not_contains" | "starts_with" | "gt" | "lt" | "is_empty" | "is_not_empty"
  | "contains_any" | "in";
export type ActionType =
  | "assign" | "set_status" | "reply" | "notify" | "run" | "http" | "rag"
  | "kb_upsert" | "contact_update" | "broadcast_send" | "set_fields" | "web_fetch" | "browser_extract"
  | "set_priority" | "add_tags" | "survey" | "stop" | "escalate";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type AssignStrategy = "specific" | "round_robin" | "least_loaded";
export type Priority = "low" | "normal" | "high" | "urgent";
export type SurveyKind = "csat" | "nps" | "both";

// Per-trigger configuration stashed on the automation (schedule cadence; webhook is server-minted).
export interface TriggerConfig {
  intervalMinutes?: number;
}

export interface Condition {
  field: string;
  op: ConditionOp;
  value: string;
}

export interface Conditions {
  match: "all" | "any";
  conditions: Condition[];
}

export interface CredBinding {
  integrationId: string;
  envName: string;
}

export interface Action {
  type: ActionType;
  assigneeId?: string | null;
  status?: "open" | "closed";
  body?: string;
  integrationId?: string;
  subject?: string;
  text?: string;
  cmd?: string;
  creds?: CredBinding[];
  // http: make an outbound request (all interpolated with the run context {{...}})
  method?: HttpMethod;
  url?: string;
  headers?: string; // newline-separated `Key: Value` lines
  httpBody?: string;
  // rag: draft a grounded answer from the KB; autoReply posts it as an agent reply
  autoReply?: boolean;
  // kb_upsert: write knowledge into the KB (all interpolated)
  kbTitle?: string;
  kbBody?: string;
  kbCollectionId?: string;
  // contact_update: upsert a contact keyed by email
  contactEmail?: string;
  contactName?: string;
  contactFields?: string; // newline-separated `Key: Value` lines
  // broadcast_send: compose + send a broadcast
  broadcastSubject?: string;
  broadcastBody?: string;
  broadcastSegment?: string;
  // set_fields: newline `Key: Value` lines → ctx.vars (values interpolated)
  setFields?: string;
  // web_fetch reuses `url`.
  // ── Dogfood L1 ──
  strategy?: AssignStrategy;   // assign: specific (assigneeId) or a pool strategy
  assigneeIds?: string[];      // assign pool (round_robin / least_loaded); empty = all agents
  cursorKey?: string;          // assign round-robin cursor scope
  priority?: Priority;         // set_priority
  tags?: string[];             // add_tags
  surveyKind?: SurveyKind;     // survey
  dedupeKey?: string;          // survey once-per-key (defaults to the ticket)
}

// ── Flows: the executable-DAG model (Lane 1 engine, Lane 2 editor) ────────────
// A node's `config` holds the type-specific payload: trigger → {}, branch →
// {conditions}, action → {action}. The canvas also stashes {position:{x,y}} in
// config for layout round-trip — the engine ignores unknown config keys.
// "item" = a general-purpose node from the ported studio library (HTTP / transforms / code / browser /
// AI-browser). Its concrete kind lives in `config.kind` (a FlowItemKind); item params ride in
// `config` too. See web/src/components/item-fields.tsx for the taxonomy + inspector forms.
export type FlowNodeType = "trigger" | "branch" | "action" | "agent" | "item";

// An agent node's config payload (Lane 4): an LLM tool-calling loop over the action primitives.
export interface AgentConfig {
  instructions?: string;
  tools?: ActionType[];
  maxSteps?: number;
  /** Per-node model override (dogfood L0-F2). Swaps the model name within the tenant's hosted
   *  provider/key; blank = the tenant default. No effect on a managed-baseline tenant. */
  model?: string;
}

// The action types an agent node may be granted as tools.
export const AGENT_TOOL_TYPES: { value: ActionType; label: string }[] = [
  { value: "reply", label: "Post a reply" },
  { value: "set_status", label: "Set status" },
  { value: "set_priority", label: "Set priority" },
  { value: "escalate", label: "Escalate" },
  { value: "add_tags", label: "Add tags" },
  { value: "assign", label: "Assign to agent" },
  { value: "survey", label: "Send a survey" },
  { value: "notify", label: "Notify a connector" },
  { value: "run", label: "Run code" },
  { value: "http", label: "Call an HTTP API" },
  { value: "rag", label: "Answer from the KB" },
  { value: "set_fields", label: "Set fields" },
  { value: "web_fetch", label: "Fetch a web page" },
  { value: "browser_extract", label: "Render a page (browser)" },
];

export interface FlowNode {
  id: string;
  type: FlowNodeType;
  config: Record<string, unknown>;
}

export interface FlowEdge {
  from: string;
  to: string;
  when?: "true" | "false";
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger | string;
  triggerConfig?: TriggerConfig | null;
  webhookToken?: string | null;
  conditions: Conditions;
  actions: Action[];
  graph?: FlowGraph | null;
  runCount: number;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  // 'routing' | 'surveys' when this is a seed automation projected from a Settings form (managed,
  // read-only in Studio); null/undefined for a hand-authored flow (dogfood L2).
  managedBy?: string | null;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  trigger: string;
  status: string; // 'success' | 'partial' | 'error'
  ticketId: string | null;
  actionsResult: unknown;
  trace?: RunTraceStep[] | null;
  error: string | null;
  createdAt: string;
}

export interface AutomationInput {
  name: string;
  trigger: AutomationTrigger;
  triggerConfig?: TriggerConfig | null;
  enabled?: boolean;
  conditions: Conditions;
  actions: Action[];
  // The executable DAG (Lane 2). When present it supersedes `actions` in the engine.
  graph?: FlowGraph | null;
}

export interface AutomationTestResult {
  matched: boolean;
  trigger: string;
  plan: { type: string; summary: string }[];
}

// A per-node execution trace entry (run history).
export interface RunTraceStep {
  nodeId?: string | null;
  type: string;
  ok: boolean;
  detail?: string;
}

// Display metadata (labels for the pickers/badges) — kept client-side, mirrors the contracts.
export const TRIGGERS: { value: AutomationTrigger; label: string; desc: string }[] = [
  { value: "manual", label: "Manual", desc: "Run on demand — no event, you trigger it yourself" },
  { value: "ticket.created", label: "Ticket created", desc: "A new ticket is opened" },
  { value: "message.received", label: "Customer message", desc: "A customer replies on a ticket" },
  { value: "ticket.closed", label: "Ticket closed", desc: "A ticket is closed" },
  { value: "ticket.assigned", label: "Ticket assigned", desc: "A ticket is assigned to someone" },
  { value: "ticket.priority_changed", label: "Priority changed", desc: "A ticket's priority is set" },
  { value: "ticket.tagged", label: "Ticket tagged", desc: "Tags are added to a ticket" },
  { value: "ticket.type_changed", label: "Type changed", desc: "A ticket's type is set" },
  { value: "note.added", label: "Note added", desc: "An internal note is posted" },
  { value: "csat.received", label: "CSAT received", desc: "A customer submits a CSAT rating" },
  { value: "nps.received", label: "NPS received", desc: "A customer submits an NPS score" },
  { value: "sla.at_risk", label: "SLA at risk", desc: "A ticket is close to breaching its SLA target" },
  { value: "sla.breached", label: "SLA breached", desc: "A ticket crossed its SLA target — escalate" },
  { value: "schedule", label: "On a schedule", desc: "Run automatically every N minutes" },
  { value: "webhook", label: "Incoming webhook", desc: "Fire when an external system POSTs to a URL" },
  { value: "discord_slash", label: "Discord /ask", desc: "A customer runs the Discord /ask slash command" },
  { value: "slack_slash", label: "Slack /ask", desc: "A customer runs the Slack /ask slash command" },
  { value: "source.synced", label: "Source synced", desc: "A knowledge source finished a re-crawl (added/updated/removed docs)" },
];

export const CONDITION_FIELDS: { value: string; label: string }[] = [
  { value: "subject", label: "Subject" },
  { value: "body", label: "Message body" },
  { value: "channelType", label: "Channel" },
  { value: "authorType", label: "Author" },
  { value: "status", label: "Status" },
  { value: "priority", label: "Priority" },
  { value: "tags", label: "Tags" },
  { value: "assigneeId", label: "Assignee" },
  { value: "whoseTurn", label: "Whose turn" },
  { value: "slaTarget", label: "SLA target (first_response/resolution)" },
];

export const CONDITION_OPS: { value: ConditionOp; label: string }[] = [
  { value: "equals", label: "equals" },
  { value: "not_equals", label: "does not equal" },
  { value: "contains", label: "contains" },
  { value: "not_contains", label: "does not contain" },
  { value: "contains_any", label: "contains any of" },
  { value: "in", label: "is any of" },
  { value: "starts_with", label: "starts with" },
  { value: "gt", label: "greater than" },
  { value: "lt", label: "less than" },
  { value: "is_empty", label: "is empty" },
  { value: "is_not_empty", label: "is not empty" },
];

export const ACTION_TYPES: { value: ActionType; label: string; desc: string }[] = [
  { value: "assign", label: "Assign to agent", desc: "Route the ticket to a teammate (or a pool)" },
  { value: "set_status", label: "Set status", desc: "Open or close the ticket" },
  { value: "set_priority", label: "Set priority", desc: "Force the ticket's priority" },
  { value: "escalate", label: "Escalate", desc: "Bump priority + optionally reassign & notify" },
  { value: "add_tags", label: "Add tags", desc: "Append tags to the ticket" },
  { value: "reply", label: "Post a reply", desc: "Send an agent message on the ticket" },
  { value: "survey", label: "Send survey", desc: "Deliver a CSAT/NPS prompt (once per ticket)" },
  { value: "notify", label: "Notify an integration", desc: "Send an alert through a connector" },
  { value: "stop", label: "Stop", desc: "Halt this flow (and later rules) — first match wins" },
  { value: "run", label: "Run code", desc: "Execute a command in a sandboxed runner" },
  { value: "http", label: "Call an HTTP API", desc: "Fetch or post to any URL, then branch on the result" },
  { value: "rag", label: "Answer from the KB", desc: "Draft a grounded answer from your knowledge base" },
  { value: "kb_upsert", label: "Save to knowledge base", desc: "Write or update an article in your KB" },
  { value: "contact_update", label: "Update a contact", desc: "Create or enrich a contact record" },
  { value: "broadcast_send", label: "Send a broadcast", desc: "Compose and send a broadcast message" },
  { value: "set_fields", label: "Set fields", desc: "Compute values into variables for later steps" },
  { value: "web_fetch", label: "Fetch a web page", desc: "Read a page's text — feed it into your KB" },
  { value: "browser_extract", label: "Render a page (browser)", desc: "Read a JS-rendered page (SPA) in a headless browser — for pages web_fetch can't read" },
];

/** Operators that take no comparison value. */
export const VALUELESS_OPS: ReadonlySet<ConditionOp> = new Set(["is_empty", "is_not_empty"]);

// Per-action effect (dogfood L3-E1) — mirrors the server TOOL_REGISTRY so the builder can badge
// every action read/update/mixed. `read` actions run even in a dry-run (safe to preview); `update`
// actions mutate customer-visible state (suppressed under dry-run); `mixed` depends on config
// (http method / rag autoReply); `flow` is control (stop).
export type ActionEffect = "read" | "update" | "mixed" | "flow";
export const ACTION_EFFECTS: Record<ActionType, ActionEffect> = {
  reply: "update", set_status: "update", assign: "update", notify: "update", run: "update",
  kb_upsert: "update", contact_update: "update", broadcast_send: "update",
  set_priority: "update", add_tags: "update", survey: "update", escalate: "update",
  http: "mixed", rag: "mixed",
  set_fields: "read", web_fetch: "read", browser_extract: "read",
  stop: "flow",
};
export const EFFECT_LABEL: Record<ActionEffect, string> = { read: "Read", update: "Writes", mixed: "Mixed", flow: "Flow" };

// RBAC-by-effect (E3), client mirror of the server policy (automations.ts EFFECT_MIN_ROLE): the
// minimum role needed to RUN a flow, by its strongest tool effect. `flow` (stop) is control, not an
// effect — it never raises the bar. Used to disable Run/Test for a role the server would 403.
const EFFECT_RANK: Record<Exclude<ActionEffect, "flow">, number> = { read: 0, update: 1, mixed: 2 };
export const EFFECT_MIN_ROLE: Record<Exclude<ActionEffect, "flow">, "viewer" | "agent" | "admin"> = {
  read: "viewer", update: "agent", mixed: "admin",
};

/** The strongest run-effect across a flow's linear actions + graph action/agent nodes. Ignores
 *  `flow` (control). Agent nodes are read from their allowed tools (default reply/set_status). */
export function flowRunEffect(actions: Action[], graph: FlowGraph | null): Exclude<ActionEffect, "flow"> {
  let rank = 0;
  const bump = (e: ActionEffect) => { if (e !== "flow") rank = Math.max(rank, EFFECT_RANK[e]); };
  for (const a of actions) bump(ACTION_EFFECTS[a.type]);
  for (const n of graph?.nodes ?? []) {
    if (n.type === "action") {
      const t = (n.config?.action as Action | undefined)?.type;
      if (t) bump(ACTION_EFFECTS[t]);
    } else if (n.type === "agent") {
      const tools = (n.config?.agent as { tools?: ActionType[] } | undefined)?.tools ?? ["reply", "set_status"];
      for (const t of tools) bump(ACTION_EFFECTS[t] ?? "update");
    }
  }
  return (["read", "update", "mixed"] as const)[rank];
}

export async function fetchAutomations(): Promise<Automation[]> {
  return (await api<{ automations: Automation[] }>("/automations")).automations;
}

export async function createAutomation(input: AutomationInput): Promise<Automation> {
  return (await api<{ automation: Automation }>("/automations", { method: "POST", body: JSON.stringify(input) })).automation;
}

/** AI flow authoring (dogfood L3-E2): a natural-language prompt → a DISABLED draft the user reviews
 *  on the canvas, then saves to arm. Returns the proposed input (no id — it isn't persisted yet). */
export async function authorAutomation(prompt: string): Promise<AutomationInput> {
  return (await api<{ automation: AutomationInput }>("/automations/author", { method: "POST", body: JSON.stringify({ prompt }) })).automation;
}

export async function updateAutomation(id: string, patch: Partial<AutomationInput>): Promise<Automation> {
  return (await api<{ automation: Automation }>(`/automations/${id}`, { method: "PATCH", body: JSON.stringify(patch) })).automation;
}

export async function deleteAutomation(id: string): Promise<void> {
  await api(`/automations/${id}`, { method: "DELETE" });
}

/** Fork-to-customize a MANAGED seed flow: deep-copies it into a disabled, editable draft and
 *  disables the managed source. Returns the new draft to open on the canvas. */
export async function graduateAutomation(id: string): Promise<Automation> {
  return (await api<{ automation: Automation }>(`/automations/${id}/graduate`, { method: "POST" })).automation;
}

export async function fetchRuns(id: string): Promise<AutomationRun[]> {
  return (await api<{ runs: AutomationRun[] }>(`/automations/${id}/runs`)).runs;
}

export async function testAutomation(id: string, context: Record<string, unknown>): Promise<AutomationTestResult> {
  return api<AutomationTestResult>(`/automations/${id}/test`, { method: "POST", body: JSON.stringify({ context }) });
}

// ── Live execution (Studio canvas "Run") ─────────────────────────────────────
// A per-node event streamed from POST /automations/:id/execute (SSE). phase "start" lights the
// node as running; "step" is an intermediate progress frame (the browser agent narrating its own
// actions — node stays running, detail updates live); "end" resolves it ok/fail with a detail line.
export interface ExecEvent {
  nodeId: string | null;
  phase: "start" | "end" | "step";
  ntype?: string;
  type?: string;
  ok?: boolean;
  detail?: string;
  /** base64 JPEG — a live browser-preview frame (type "frame"; no nodeId). */
  frame?: string;
}
export interface ExecuteResult {
  status: "success" | "partial" | "error";
  matched: boolean;
  trace: RunTraceStep[];
  error: string | null;
}

/** Stream a live flow execution. Uses fetch (not EventSource — we need the Bearer header + a
 *  POST body) and parses the SSE frames off the response body. Calls onStep for each per-node
 *  event and resolves with the final result. dryRun (default true) keeps side effects suppressed. */
export async function executeAutomation(
  id: string,
  opts: { context?: Record<string, unknown>; dryRun?: boolean },
  onStep: (ev: ExecEvent) => void,
): Promise<ExecuteResult> {
  const res = await fetch(`${API_URL}/automations/${id}/execute`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}),
    },
    body: JSON.stringify({ context: opts.context ?? {}, dryRun: opts.dryRun !== false }),
  });
  if (!res.ok || !res.body) {
    const err = new Error(`HTTP ${res.status}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let result: ExecuteResult | null = null;
  let streamErr: string | null = null;

  const handleFrame = (frame: string) => {
    let event = "message";
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) return;
    let parsed: unknown;
    try { parsed = JSON.parse(data); } catch { return; }
    if (event === "step") onStep(parsed as ExecEvent);
    else if (event === "done") result = parsed as ExecuteResult;
    else if (event === "error") streamErr = (parsed as { message?: string }).message ?? "run failed";
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      handleFrame(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
    }
  }
  if (buf.trim()) handleFrame(buf);
  if (streamErr) throw new Error(streamErr);
  return result ?? { status: "error", matched: false, trace: [], error: "no result" };
}

// ── Runner runs (the execution runner's real container runs) ──────────────────
export interface RunnerRun {
  id: string;
  status: string; // 'queued' | 'running' | 'succeeded' | 'failed'
  kind: string;
  payload: Record<string, unknown>;
  result: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export async function fetchRunnerRuns(limit = 50): Promise<RunnerRun[]> {
  return (await api<{ runs: RunnerRun[] }>(`/runs?limit=${limit}`)).runs;
}

export async function fetchRunnerRun(id: string): Promise<RunnerRun> {
  return (await api<{ run: RunnerRun }>(`/runs/${id}`)).run;
}

// ── Runner run history + replay (0092) ───────────────────────────────────────

export interface RunnerRun {
  id: string;
  status: string;
  kind: string;
  payload: Record<string, unknown>;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  nodeEvents: Array<{ type?: string; nodeId?: string; kind?: string; status?: string; detail?: string; ms?: number }>;
  replayKey: string | null;
}

export async function listRunnerRuns(limit = 50): Promise<RunnerRun[]> {
  return (await api<{ runs: RunnerRun[] }>(`/runs?limit=${limit}`)).runs;
}

export async function fetchRunReplayUrl(runId: string): Promise<string | null> {
  try {
    return (await api<{ url: string }>(`/runs/${runId}/replay`)).url;
  } catch {
    return null; // no replay recorded
  }
}
