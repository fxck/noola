import { useEffect, useMemo, useRef, useState } from "react";
import { getRouteApi, Link } from "@tanstack/react-router";
import {
  Waypoints,
  Plus,
  Trash2,
  ArrowLeft,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  FlaskConical,
  Play,
  ChevronRight,
  Users as UsersIcon,
  Sparkles,
  GitFork,
  Lock,
  Film,
  PlayCircle,
} from "lucide-react";
import { TestBenchView } from "@/routes/simulations";
import { RunDock, type RunLogEntry } from "@/components/run-dock";
import { ITEM_KINDS, type FlowItemKind } from "@/components/item-fields";
import { ActivityView } from "@/components/studio/activity-view";
import { TAB_BASE, TAB_ON, TAB_OFF } from "@/components/ui/segmented";
import { useAuth } from "@/auth/auth";
import { api, getToken } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toaster";
import { cn } from "@/lib/utils";
import {
  type Automation,
  type AutomationRun,
  type ExecEvent,
  type ExecuteResult,
  type FlowGraph,
  TRIGGERS,
  ACTION_TYPES,
  fetchAutomations,
  createAutomation,
  authorAutomation,
  updateAutomation,
  deleteAutomation,
  graduateAutomation,
  fetchRuns,
  executeAutomation,
  flowRunEffect,
  EFFECT_MIN_ROLE,
  type RunnerRun,
  listRunnerRuns,
  fetchRunReplayUrl,
} from "@/lib/automations";
import { type Integration, fetchIntegrations } from "@/lib/integrations";
import { AutomationCanvas, type NodeRunStatus } from "@/components/automation-canvas";
import { type Draft, emptyDraft, draftFrom, draftFromAuthored, deriveGraph, pipelineDraft } from "@/lib/automation-draft";
import { useFlowCollab } from "@/lib/use-flow-collab";

const routeApi = getRouteApi("/studio");
const RANK: Record<string, number> = { viewer: 0, agent: 1, admin: 2, owner: 3 };

interface AgentUser {
  id: string;
  name: string;
  email: string;
  role: string;
}

function triggerLabel(t: string): string {
  return TRIGGERS.find((x) => x.value === t)?.label ?? t;
}

// Progressive disclosure (dogfood L2): a seed flow projected from a Settings form is edited in that
// form, not on the canvas. Map its managed_by flag to the owning Settings page.
function managedTarget(managedBy: string | null | undefined): { label: string; to: string } | null {
  if (managedBy === "routing") return { label: "Routing", to: "/settings/routing" };
  if (managedBy === "surveys") return { label: "Surveys", to: "/settings/surveys" };
  if (managedBy === "autotag") return { label: "Auto-tagging", to: "/settings/tag-rules" };
  return null;
}

// A studio automation is a flow — summarise it from its graph (falling back to the linear
// action list for legacy simple rules that were never opened on the canvas).
function graphSummary(a: Automation): string {
  const g = a.graph;
  if (g && (g.nodes?.length ?? 0) > 0) {
    const actions = g.nodes.filter((n) => n.type === "action").length;
    const branches = g.nodes.filter((n) => n.type === "branch").length;
    const agents = g.nodes.filter((n) => n.type === "agent").length;
    const parts: string[] = [];
    if (agents) parts.push(`${agents} AI agent${agents > 1 ? "s" : ""}`);
    if (branches) parts.push(`${branches} branch${branches > 1 ? "es" : ""}`);
    if (actions) parts.push(`${actions} action${actions > 1 ? "s" : ""}`);
    return parts.join(" · ") || "just a trigger";
  }
  const labels = (a.actions ?? []).map((x) => ACTION_TYPES.find((t) => t.value === x.type)?.label ?? x.type);
  return labels.join(" · ") || "no steps yet";
}

function ago(iso: string | null): string {
  if (!iso) return "never";
  const d = Date.now() - new Date(iso).getTime();
  const m = Math.floor(d / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function runBadge(status: string): { variant: "success" | "warning" | "destructive"; label: string } {
  if (status === "success") return { variant: "success", label: "Success" };
  if (status === "partial") return { variant: "warning", label: "Partial" };
  return { variant: "destructive", label: "Error" };
}

// A single dot colour for a run outcome — the vocabulary shared by the health pill + the strip.
function runDotClass(status: string): string {
  if (status === "success") return "bg-success";
  if (status === "partial") return "bg-warning";
  return "bg-destructive";
}

// Run-health: a health dot/pill + a 7-dot recent-run strip (oldest → newest), derived from the
// flow's already-loaded run history. Doubles as the "Runs" affordance — clicking opens the panel.
function RunHealth({ runs, onClick }: { runs: AutomationRun[] | null; onClick: () => void }) {
  const recent = (runs ?? []).slice(0, 7).reverse();
  const failing = recent.filter((r) => r.status !== "success").length;
  const health =
    runs === null
      ? { dot: "bg-muted-foreground/40", label: "Runs" }
      : recent.length === 0
        ? { dot: "border border-muted-foreground/40", label: "No runs" }
        : failing === 0
          ? { dot: "bg-success", label: "Healthy" }
          : failing >= recent.length
            ? { dot: "bg-destructive", label: "Failing" }
            : { dot: "bg-warning", label: `${failing} failing` };
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 rounded-md border px-2 py-1 text-xs transition-[transform,background-color] duration-100 ease-[var(--ease-out-strong)] hover:bg-muted/50 active:scale-[0.98]"
      title="Recent runs"
    >
      <span className={cn("size-2 shrink-0 rounded-full", health.dot)} />
      <span className="font-medium text-muted-foreground">{health.label}</span>
      {recent.length > 0 && (
        <span className="ml-0.5 flex items-center gap-0.5">
          {recent.map((r) => (
            <span key={r.id} className={cn("size-1.5 rounded-full", runDotClass(r.status))} />
          ))}
        </span>
      )}
    </button>
  );
}

/** Flows | Test bench — the Studio view switch (§3: same slot on both views). */
function StudioViewSwitch({ current, className }: { current: "flows" | "test" | "activity"; className?: string }) {
  return (
    <div
      role="tablist"
      aria-label="Studio views"
      className={cn("inline-flex items-center gap-0.5 rounded-lg border bg-muted/60 p-0.5 font-normal", className)}
    >
      <Link to="/studio" role="tab" aria-selected={current === "flows"} className={cn(TAB_BASE, current === "flows" ? TAB_ON : TAB_OFF)}>
        Flows
      </Link>
      <Link to="/studio" search={{ view: "test" }} role="tab" aria-selected={current === "test"} className={cn(TAB_BASE, current === "test" ? TAB_ON : TAB_OFF)}>
        Test bench
      </Link>
      <Link to="/studio" search={{ view: "activity" }} role="tab" aria-selected={current === "activity"} className={cn(TAB_BASE, current === "activity" ? TAB_ON : TAB_OFF)}>
        Activity
      </Link>
    </div>
  );
}

export function AgentStudioPage() {
  const { user } = useAuth();
  const isAdmin = (RANK[user?.role ?? ""] ?? -1) >= RANK.admin;
  const search = routeApi.useSearch();
  const navigate = routeApi.useNavigate();

  const [automations, setAutomations] = useState<Automation[] | null>(null);
  const [users, setUsers] = useState<AgentUser[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loadError, setLoadError] = useState(false);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [authorPrompt, setAuthorPrompt] = useState("");
  const [authoring, setAuthoring] = useState(false);
  const [runs, setRuns] = useState<AutomationRun[] | null>(null);
  const [showRuns, setShowRuns] = useState(false);
  // Browser-flow replays (0092): container runs (runner_runs) with a recorded .webm. Fetched
  // when the runs drawer opens; a row's ▶ opens the RunDock in replay mode.
  const [runnerRuns, setRunnerRuns] = useState<RunnerRun[]>([]);
  const [replayUrl, setReplayUrl] = useState<string | null>(null);
  const [replayLabel, setReplayLabel] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Live execution overlay: per-node status, the final result, a run-in-flight flag, and
  // whether a run performs real side effects (dryRun = safe default).
  const [runStatus, setRunStatus] = useState<Record<string, { status: NodeRunStatus; detail?: string }>>({});
  const [execResult, setExecResult] = useState<ExecuteResult | null>(null);
  const [running, setRunning] = useState(false);
  const [liveMode, setLiveMode] = useState(false);
  // Run dock (weft LiveDock port): live browser frames + a per-node event feed for the active run.
  const [liveFrame, setLiveFrame] = useState<string | null>(null);
  const [runLog, setRunLog] = useState<RunLogEntry[]>([]);
  const [dockOpen, setDockOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<Automation | null>(null);
  const [removing, setRemoving] = useState(false);

  const load = useRef(async () => {
    setLoadError(false);
    try {
      const [a, u, ig] = await Promise.all([
        fetchAutomations(),
        api<{ users: AgentUser[] }>("/users").then((r) => r.users).catch(() => []),
        fetchIntegrations().then((r) => r.integrations).catch(() => []),
      ]);
      setAutomations(a);
      setUsers(u);
      setIntegrations(ig);
    } catch {
      setLoadError(true);
    }
  }).current;

  useEffect(() => {
    void load();
  }, [load]);

  // Deep link: `/studio?id=<automationId>` opens that flow once the list has loaded.
  useEffect(() => {
    if (!automations) return;
    if (search.id && (!draft || draft.id !== search.id)) {
      const a = automations.find((x) => x.id === search.id);
      if (a) openDraft(a);
    } else if (!search.id && draft?.id) {
      setDraft(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [automations, search.id]);

  // `/studio?new=pipeline` — the Sources bridge: open a fresh KB-sync pipeline on the canvas.
  useEffect(() => {
    if (search.new === "pipeline" && !draft) {
      clearRun();
      setShowRuns(false);
      setRuns(null);
      setDraft(pipelineDraft());
      void navigate({ search: {} });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.new]);

  const assigneeOptions = useMemo(
    () => [{ value: "", label: "Unassign" }, ...users.map((u) => ({ value: u.id, label: u.name || u.email }))],
    [users],
  );
  const integrationOptions = useMemo(
    () => integrations.filter((i) => i.enabled).map((i) => ({ value: i.id, label: i.name })),
    [integrations],
  );

  // RBAC-by-effect (E3): the role needed to run this flow depends on its strongest tool effect, so
  // a viewer can run a read-only flow while update/mixed flows disable Run for them (the server is
  // authoritative and 403s; this just avoids a dead-end click and explains why).
  const runEffect = useMemo(() => (draft ? flowRunEffect(draft.actions, draft.graph ?? null) : "read"), [draft]);
  const runMinRole = EFFECT_MIN_ROLE[runEffect];
  const canRun = (RANK[user?.role ?? ""] ?? -1) >= RANK[runMinRole];

  function clearRun() {
    setExecResult(null);
    setRunStatus({});
  }
  function openDraft(a: Automation) {
    clearRun();
    setShowRuns(false);
    setDraft(draftFrom(a));
    setRuns(null);
    void fetchRuns(a.id).then(setRuns).catch(() => setRuns([]));
  }
  function openExisting(a: Automation) {
    void navigate({ search: { id: a.id } });
  }
  function openNew() {
    clearRun();
    setShowRuns(false);
    setRuns(null);
    setDraft(emptyDraft());
    void navigate({ search: {} });
  }
  function closeEditor() {
    setDraft(null);
    void navigate({ search: {} });
  }

  // AI flow authoring (dogfood L3-E2): describe → the model drafts a typed flow → open it for
  // review. The draft is DISABLED; the user arms it by saving. Safe because every action is typed
  // (dry-runnable before it ever runs live).
  async function onAuthor() {
    const p = authorPrompt.trim();
    if (!p || authoring) return;
    setAuthoring(true);
    try {
      const authored = await authorAutomation(p);
      setAuthorPrompt("");
      clearRun();
      setShowRuns(false);
      setRuns(null);
      setDraft(draftFromAuthored(authored));
      void navigate({ search: {} });
      toast.success("Draft ready — review it, then Save to arm.");
    } catch (e) {
      const err = e as { status?: number; detail?: string };
      toast.error(err.detail ?? (err.status === 422 ? "Couldn't build that flow — try rephrasing." : "AI authoring failed."));
    } finally {
      setAuthoring(false);
    }
  }

  // Fork-to-customize: deep-copy a managed seed flow into an editable, disabled draft (managed
  // source is disabled server-side) and open the fork on the canvas to arm + customize freely.
  const [forkTarget, setForkTarget] = useState<Automation | null>(null);
  const [forking, setForking] = useState(false);
  async function onForkConfirm() {
    if (!forkTarget) return;
    setForking(true);
    try {
      const fork = await graduateAutomation(forkTarget.id);
      await load(); // pick up the disabled source + the new draft
      setForkTarget(null);
      openExisting(fork); // open the fork on the canvas
      toast.success("Forked — this copy is disconnected from Settings. Edit and enable it to arm.");
    } catch (e) {
      toast.error((e as { status?: number }).status === 403 ? "Only admins can fork a managed flow." : "Couldn't fork this flow.");
    } finally {
      setForking(false);
    }
  }

  async function onToggle(a: Automation) {
    setBusyId(a.id);
    try {
      await updateAutomation(a.id, { enabled: !a.enabled });
      setAutomations((xs) => (xs ?? []).map((x) => (x.id === a.id ? { ...x, enabled: !x.enabled } : x)));
    } catch (e) {
      toast.error((e as { status?: number }).status === 403 ? "Only admins can change automations." : "Couldn't update.");
    } finally {
      setBusyId(null);
    }
  }

  function payload(d: Draft, graph: FlowGraph) {
    return {
      name: d.name.trim(),
      trigger: d.trigger,
      triggerConfig: d.triggerConfig,
      enabled: d.enabled,
      conditions: { match: d.match, conditions: d.conditions },
      actions: d.actions,
      // Canvas-first: the flow graph is always the source of truth in the engine.
      graph,
    };
  }

  async function onSave() {
    if (!draft) return;
    if (!draft.name.trim()) {
      toast.error("Give your flow a name.");
      return;
    }
    const graph: FlowGraph = collabEnabled ? collab.graph : draft.graph ?? deriveGraph(draft);
    setSaving(true);
    try {
      if (draft.id) {
        await updateAutomation(draft.id, payload(draft, graph));
        toast.success("Flow saved.");
      } else {
        const created = await createAutomation(payload(draft, graph));
        toast.success("Flow created.");
        await load();
        void navigate({ search: { id: created.id } });
        setSaving(false);
        return;
      }
      await load();
    } catch (e) {
      toast.error((e as { status?: number }).status === 403 ? "Only admins can manage flows." : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  }

  // Live run: actually walk the flow on the server, lighting each node up as it executes.
  // dryRun (default) suppresses side effects; Live mode performs them for real and awaits the
  // runner's container output. Streams per-node events onto the canvas.
  async function onRun(liveOverride?: boolean) {
    if (!draft?.id) {
      toast.error("Save the flow first, then run it.");
      return;
    }
    const live = liveOverride ?? liveMode;
    setRunning(true);
    setExecResult(null);
    setRunStatus({});
    setRunLog([]);
    setLiveFrame(null);
    setReplayUrl(null); // a fresh run supersedes any replay showing in the dock
    setReplayLabel(null);
    // The dock earns its screen space only when there's something to watch: a real run of a flow
    // with browser steps (frames stream from the container's Chromium).
    const browserKinds = new Set(ITEM_KINDS.filter((k) => k.browser).map((k) => k.kind as string));
    const hasBrowser = (draft.graph?.nodes ?? []).some(
      (n) => n.type === "item" && browserKinds.has(String(n.config?.kind ?? "")),
    );
    if (live && hasBrowser) setDockOpen(true);
    const t0 = Date.now();
    const nodeLabel = (id: string): string => {
      const n = draft.graph?.nodes.find((x) => x.id === id);
      if (!n) return id;
      if (n.type === "item") return ITEM_KINDS.find((k) => k.kind === (n.config?.kind as FlowItemKind))?.label ?? String(n.config?.kind ?? "step");
      if (n.type === "action") return String((n.config?.action as { type?: string } | undefined)?.type ?? "action");
      if (n.type === "agent") return "AI agent";
      if (n.type === "branch") return "Branch";
      return "Trigger";
    };
    try {
      const context: Record<string, unknown> = {
        subject: "Sample subject",
        body: "I would like a refund please",
        channelType: "discord",
        authorType: "customer",
        status: "open",
      };
      const result = await executeAutomation(
        draft.id,
        { context, dryRun: !live },
        (ev: ExecEvent) => {
          if (ev.type === "frame" && ev.frame) {
            setLiveFrame(`data:image/jpeg;base64,${ev.frame}`);
            return;
          }
          if (!ev.nodeId) return; // linear (non-graph) rules have no canvas node to light
          setRunLog((l) => [
            ...l.slice(-199),
            { t: Date.now() - t0, nodeId: ev.nodeId as string, label: nodeLabel(ev.nodeId as string), phase: ev.phase, ok: ev.ok, detail: ev.detail },
          ]);
          setRunStatus((m) => ({
            ...m,
            [ev.nodeId as string]:
              ev.phase === "start"
                ? { status: "running" }
                : ev.phase === "step"
                  ? { status: "running", detail: ev.detail }
                  : { status: ev.ok ? "ok" : "fail", detail: ev.detail },
          }));
        },
      );
      setExecResult(result);
      // A live run mutates state + logs a run — refresh the history.
      if (live) void fetchRuns(draft.id).then(setRuns).catch(() => {});
    } catch (e) {
      toast.error((e as { status?: number }).status === 403 ? "Only admins can run flows." : "Couldn't run the flow.");
    } finally {
      setRunning(false);
    }
  }

  async function onConfirmRemove() {
    if (!removeTarget) return;
    setRemoving(true);
    try {
      await deleteAutomation(removeTarget.id);
      setAutomations((xs) => (xs ?? []).filter((x) => x.id !== removeTarget.id));
      toast.success(`${removeTarget.name} deleted.`);
      const wasOpen = draft?.id === removeTarget.id;
      setRemoveTarget(null);
      if (wasOpen) closeEditor();
    } catch {
      toast.error("Couldn't delete the flow.");
    } finally {
      setRemoving(false);
    }
  }

  const setD = (fn: (d: Draft) => Draft) => setDraft((d) => (d ? fn(d) : d));
  const setGraph = (g: FlowGraph) => setD((d) => ({ ...d, graph: g }));

  // Collaborative canvas: for a SAVED flow, edits ride the shared Yjs doc on the edge.
  const collabEnabled = !!draft?.id;
  const collab = useFlowCollab({
    automationId: draft?.id ?? null,
    enabled: collabEnabled,
    token: getToken(),
    identity: { id: user?.id, name: user?.name || user?.email || "You" },
    seedGraph: draft ? draft.graph ?? deriveGraph(draft) : { nodes: [], edges: [] },
  });

  return (
    <>
      {!draft && search.view === "test" ? (
        // ── TEST BENCH (agent simulation — dry-runs of the AI these flows arm) ──
        <TestBenchView viewSwitch={<StudioViewSwitch current="test" />} />
      ) : !draft && search.view === "activity" ? (
        // ── ACTIVITY (the live autopilot board — from the old /queue) ──
        <ActivityView viewSwitch={<StudioViewSwitch current="activity" />} />
      ) : !draft ? (
        // ── LIST (pane-header contract §3; full-bleed rows on the panel §2) ──
        <div className="flex min-h-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center gap-2 px-4">
            <h2 className="text-sm font-semibold tracking-tight">Flows</h2>
            {automations && automations.length > 0 && (
              <span className="text-xs tabular-nums text-muted-foreground">{automations.length}</span>
            )}
            <div className="ml-auto flex items-center gap-2">
              <StudioViewSwitch current="flows" />
              {isAdmin && (
                <Button size="sm" className="h-8 shrink-0 gap-1.5 text-xs" onClick={openNew}>
                  <Plus className="size-3.5" /> New flow
                </Button>
              )}
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {isAdmin && (
              <div className="mx-4 mb-3 mt-1 rounded-xl border bg-gradient-to-br from-primary/5 to-transparent p-4 shadow-sm">
                <div className="flex items-center gap-1.5 text-micro font-semibold uppercase tracking-wide text-muted-foreground">
                  <Sparkles className="size-3.5 text-primary" /> Describe a flow
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  Say what to automate in plain English — the AI drafts a typed flow you review, dry-run, and arm.
                </p>
                <div className="mt-2.5 flex gap-2">
                  <Input
                    value={authorPrompt}
                    onChange={(e) => setAuthorPrompt(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void onAuthor(); }}
                    placeholder="e.g. When a Discord ticket comes in, tag it discord and round-robin assign it"
                    disabled={authoring}
                    aria-label="Describe a flow"
                    className="min-w-0 flex-1"
                  />
                  <Button onClick={() => void onAuthor()} disabled={authoring || !authorPrompt.trim()} className="shrink-0">
                    {authoring ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <Sparkles />} Generate
                  </Button>
                </div>
              </div>
            )}

            {automations === null && !loadError ? (
              <div className="grid place-items-center py-16"><Spinner /></div>
            ) : loadError ? (
              <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                <AlertTriangle className="size-7 text-muted-foreground/50" />
                <p className="text-sm text-muted-foreground">Couldn't load flows.</p>
                <Button variant="outline" size="sm" onClick={() => void load()}>Try again</Button>
              </div>
            ) : (automations?.length ?? 0) === 0 ? (
              <div className="mx-4 mt-1 flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed py-16 text-center">
                <Waypoints className="size-8 text-muted-foreground/40" />
                <p className="text-sm font-medium">No flows yet</p>
                <p className="max-w-md text-sm text-muted-foreground">
                  Build your first flow — auto-triage Discord tickets, escalate refunds, or spin up an AI agent that
                  answers from your KB and hands off to a human when it's unsure.
                </p>
                {isAdmin && (
                  <Button variant="outline" size="sm" className="mt-1" onClick={openNew}><Plus /> New flow</Button>
                )}
              </div>
            ) : (
              (() => {
                // Group the list: hand-built flows first, then the managed seed flows (projected
                // from Settings forms) under their own header — "what is the system doing on my
                // behalf?". Managed rows are read-only on the canvas but forkable.
                const list = automations ?? [];
                const custom = list.filter((a) => !a.managedBy);
                const managedList = list.filter((a) => a.managedBy);

                const row = (a: Automation) => {
                  const managed = managedTarget(a.managedBy);
                  return (
                    <li key={a.id} className="group relative flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/40">
                      {/* scan-bar — the shared hover signature (nav + every list) */}
                      <span className="pointer-events-none absolute inset-y-0 left-0 w-0.5 origin-center scale-y-0 bg-primary transition-transform duration-100 ease-[var(--ease-out-strong)] group-hover:scale-y-100 motion-reduce:transition-none" />
                      <div className="flex w-9 shrink-0 justify-center">
                        {busyId === a.id ? (
                          <Loader2 className="size-4 animate-spin text-muted-foreground" />
                        ) : (
                          <Switch
                            checked={a.enabled}
                            disabled={!!managed || !isAdmin}
                            onCheckedChange={() => void onToggle(a)}
                            aria-label={a.enabled ? "Enabled — pause this flow" : "Paused — enable this flow"}
                            title={managed ? `Managed in Settings → ${managed.label}` : a.enabled ? "Enabled — click to pause" : "Paused — click to enable"}
                          />
                        )}
                      </div>
                      {managed ? (
                        // Managed seed flow — read-only on the canvas; edited in its Settings form.
                        <Link to={managed.to} className="min-w-0 flex-1 text-left">
                          <div className="flex items-center gap-1.5">
                            <Lock className="size-3 shrink-0 text-muted-foreground/60" />
                            <span className="truncate text-sm font-medium">{a.name}</span>
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
                            <span className="font-medium text-foreground/70">When</span> {triggerLabel(a.trigger)}
                            <span className="text-muted-foreground/40">·</span>
                            {graphSummary(a)}
                            <span className="text-muted-foreground/40">·</span>
                            <span>edit in Settings → {managed.label}</span>
                          </div>
                        </Link>
                      ) : (
                        <button className="min-w-0 flex-1 text-left" onClick={() => openExisting(a)}>
                          {/* No "Paused" chip — the OFF toggle already carries that fact (§5). */}
                          <div className="truncate text-sm font-medium">{a.name}</div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
                            <span className="font-medium text-foreground/70">When</span> {triggerLabel(a.trigger)}
                            <span className="text-muted-foreground/40">·</span>
                            {graphSummary(a)}
                          </div>
                        </button>
                      )}
                      {managed && isAdmin && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="hidden h-7 shrink-0 gap-1 px-2 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 sm:inline-flex"
                          onClick={() => setForkTarget(a)}
                          title="Fork this managed flow into an editable copy"
                        >
                          <GitFork className="size-3.5" /> Fork
                        </Button>
                      )}
                      <div className="hidden shrink-0 text-right text-xs text-muted-foreground sm:block">
                        <div className="tabular-nums">{a.runCount} run{a.runCount === 1 ? "" : "s"}</div>
                        <div>{ago(a.lastRunAt)}</div>
                      </div>
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground/40" />
                    </li>
                  );
                };

                return (
                  <div>
                    {custom.length > 0 && <ul className="divide-y">{custom.map(row)}</ul>}
                    {managedList.length > 0 && (
                      <div className={custom.length > 0 ? "mt-2 border-t" : ""}>
                        <div className="flex items-center gap-2 px-4 pb-1 pt-3">
                          <Lock className="size-3.5 text-muted-foreground/60" />
                          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">Managed</p>
                          <p className="text-xs text-muted-foreground">generated from your Settings — fork one to customize</p>
                        </div>
                        <ul className="divide-y">{managedList.map(row)}</ul>
                      </div>
                    )}
                  </div>
                );
              })()
            )}
          </div>
        </div>
      ) : (
        // ── BUILDER (full-screen, canvas-first) ──
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-card px-4 py-2.5">
            <Button variant="ghost" size="icon" className="size-8" onClick={closeEditor} aria-label="Back to Studio">
              <ArrowLeft className="size-4" />
            </Button>
            <Input
              className="h-8 w-56 border-transparent bg-transparent px-2 text-sm font-semibold shadow-none focus-visible:border-input focus-visible:bg-background"
              placeholder="Untitled flow"
              value={draft.name}
              onChange={(e) => setD((d) => ({ ...d, name: e.target.value }))}
              disabled={!isAdmin}
            />
            {collabEnabled && collab.status === "live" && (
              <span className="hidden items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400 sm:inline-flex">
                <span className="size-1.5 rounded-full bg-emerald-500" />
                {collab.peers.length > 0 ? (
                  <><UsersIcon className="size-3" /> {collab.peers.length + 1} editing</>
                ) : "Live"}
              </span>
            )}

            <div className="ml-auto flex items-center gap-2">
              {isAdmin && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Switch
                    checked={draft.enabled}
                    onCheckedChange={(v) => setD((d) => ({ ...d, enabled: v }))}
                    aria-label="Enabled"
                  />
                  Enabled
                </div>
              )}
              {draft.id && <RunHealth runs={runs} onClick={() => { setShowRuns((s) => !s); if (draft.id) void listRunnerRuns(40).then(setRunnerRuns).catch(() => setRunnerRuns([])); }} />}
              {draft.id && isAdmin && draft.trigger !== "manual" && (
                <div
                  className={cn(
                    "hidden items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium sm:flex",
                    liveMode
                      ? "border-warning/50 bg-warning/10 text-warning"
                      : "text-muted-foreground",
                  )}
                  title={liveMode ? "Live — actions are performed for real" : "Dry run — safe, no side effects"}
                >
                  <Switch
                    checked={liveMode}
                    onCheckedChange={setLiveMode}
                    aria-label="Live mode — actions are performed for real"
                  />
                  Live
                </div>
              )}
              {draft.id && !dockOpen && (running || liveFrame) && (
                <Button variant="ghost" size="sm" onClick={() => setDockOpen(true)} title="Show the live preview">
                  Watch
                </Button>
              )}
              {draft.id && draft.trigger === "manual" ? (
                // A manual flow's whole point is running it on demand — an explicit primary Run
                // (real side effects) plus a quiet dry-run Test; the Live toggle is redundant here.
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void onRun(false)}
                    disabled={running || !canRun}
                    title="Dry run — safe, no side effects"
                  >
                    {running ? <Loader2 className="animate-spin" /> : <FlaskConical />}
                    Test
                  </Button>
                  <Button
                    variant="brand"
                    size="sm"
                    onClick={() => void onRun(true)}
                    disabled={running || !canRun}
                    title={!canRun ? `Running this flow needs the ${runMinRole} role or higher — it performs ${runEffect} actions.` : "Run now — actions are performed for real"}
                  >
                    {running ? <Loader2 className="animate-spin" /> : <Play />}
                    Run
                  </Button>
                </>
              ) : draft.id ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void onRun()}
                  disabled={running || !canRun}
                  title={!canRun ? `Running this flow needs the ${runMinRole} role or higher — it performs ${runEffect} actions.` : undefined}
                >
                  {running ? <Loader2 className="animate-spin" /> : liveMode ? <Play /> : <FlaskConical />}
                  {liveMode ? "Run" : "Test"}
                </Button>
              ) : null}
              {isAdmin && (
                <Button size="sm" onClick={() => void onSave()} disabled={saving}>
                  {saving ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
                  {draft.id ? "Save" : "Create"}
                </Button>
              )}
              {isAdmin && draft.id && (
                <Button variant="ghost" size="icon" className="size-8 text-muted-foreground hover:text-destructive" aria-label="Delete flow" onClick={() => setRemoveTarget(automations?.find((x) => x.id === draft.id) ?? null)}>
                  <Trash2 className="size-4" />
                </Button>
              )}
            </div>
          </div>

          {!isAdmin && (
            <div className="flex items-center gap-2 border-b bg-amber-500/5 px-4 py-1.5 text-xs text-muted-foreground">
              <AlertTriangle className="size-3.5 text-amber-500" /> Read-only — only admins can edit flows.
            </div>
          )}

          <div className="relative min-h-0 flex-1">
            <RunDock
              open={dockOpen}
              running={running}
              frame={liveFrame}
              log={runLog}
              replayUrl={replayUrl}
              replayLabel={replayLabel}
              onClose={() => { setDockOpen(false); setReplayUrl(null); setReplayLabel(null); }}
            />
            <AutomationCanvas
              draft={draft}
              isAdmin={isAdmin}
              assigneeOptions={assigneeOptions}
              integrationOptions={integrationOptions}
              setTrigger={(t) => setD((d) => ({ ...d, trigger: t }))}
              setTriggerConfig={(c) => setD((d) => ({ ...d, triggerConfig: c }))}
              onGraphChange={collabEnabled ? collab.onGraphChange : setGraph}
              graphOverride={collabEnabled ? collab.graph : undefined}
              runStatus={runStatus}
            />

            {/* live-run summary — floats over the canvas while / after a run */}
            {(running || execResult) && (
              <div className="absolute bottom-3 left-3 z-10 max-w-md rounded-lg border bg-card p-3 text-sm shadow-lg">
                <div className="flex items-center gap-2 font-medium">
                  {running ? (
                    <><Loader2 className="size-4 animate-spin text-amber-500" /> Running {liveMode ? "live" : "dry run"}…</>
                  ) : execResult?.status === "success" ? (
                    <><CheckCircle2 className="size-4 text-emerald-500" /> Finished — success</>
                  ) : execResult?.status === "partial" ? (
                    <><AlertTriangle className="size-4 text-amber-500" /> Finished — some steps failed</>
                  ) : (
                    <><XCircle className="size-4 text-destructive" /> {execResult?.error ? `Error: ${execResult.error}` : "Run failed"}</>
                  )}
                  {!running && (
                    <button className="ml-auto text-muted-foreground hover:text-foreground" onClick={clearRun} aria-label="Dismiss"><XCircle className="size-3.5" /></button>
                  )}
                </div>
                <p className="mt-2 text-micro text-muted-foreground/70">
                  {liveMode
                    ? "Live run — actions performed for real; run recorded in history."
                    : "Dry run — the flow executes but side-effecting steps only report what they'd do."}
                </p>
              </div>
            )}

            {/* recent runs — slide-in panel */}
            {showRuns && draft.id && (
              <div className="absolute inset-y-0 right-0 z-10 flex w-80 flex-col border-l bg-card shadow-xl">
                <div className="flex items-center justify-between border-b px-3 py-2.5">
                  <h3 className="text-sm font-semibold">Recent runs</h3>
                  <button className="text-muted-foreground hover:text-foreground" onClick={() => setShowRuns(false)} aria-label="Close"><XCircle className="size-4" /></button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-3">
                  {runs === null ? (
                    <div className="py-6 text-center"><Spinner /></div>
                  ) : runs.length === 0 ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">No runs yet — this flow hasn't fired.</p>
                  ) : (
                    <ul className="space-y-2">
                      {runs.map((r) => {
                        const b = runBadge(r.status);
                        return (
                          <li key={r.id} className="rounded-lg border bg-background p-2.5 text-xs">
                            <div className="flex items-center gap-2">
                              <Badge variant={b.variant}>{b.label}</Badge>
                              <span className="text-muted-foreground">{ago(r.createdAt)}</span>
                            </div>
                            {r.trace && r.trace.length > 0 && (
                              <ul className="mt-1.5 space-y-1">
                                {r.trace.map((s, i) => (
                                  <li key={i} className="flex items-start gap-1.5">
                                    <span className={cn("mt-0.5 grid size-3.5 shrink-0 place-items-center rounded-full text-[9px] font-bold text-white", s.ok ? "bg-emerald-500" : "bg-destructive")}>
                                      {s.ok ? "✓" : "!"}
                                    </span>
                                    <span className="min-w-0">
                                      <span className="font-medium">{s.type}</span>
                                      {s.detail && <span className="text-muted-foreground"> — {s.detail}</span>}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            )}
                            {r.error && <p className="mt-1 text-destructive">{r.error}</p>}
                          </li>
                        );
                      })}
                    </ul>
                  )}

                  {/* Browser replays (0092): container runs with a recorded .webm for this flow. */}
                  {(() => {
                    const replays = runnerRuns.filter(
                      (rr) => rr.replayKey && (rr.payload as { automationId?: string })?.automationId === draft.id,
                    );
                    if (!replays.length) return null;
                    return (
                      <div className="mt-4">
                        <h4 className="mb-1.5 flex items-center gap-1.5 text-micro font-semibold uppercase tracking-wide text-muted-foreground">
                          <Film className="size-3.5" /> Browser replays
                        </h4>
                        <ul className="space-y-1.5">
                          {replays.map((rr) => (
                            <li key={rr.id}>
                              <button
                                type="button"
                                className="flex w-full items-center gap-2 rounded-lg border bg-background px-2.5 py-2 text-left text-xs transition-colors hover:bg-muted/50"
                                onClick={async () => {
                                  const url = await fetchRunReplayUrl(rr.id);
                                  if (!url) { toast.error("That replay isn't available."); return; }
                                  setReplayUrl(url);
                                  setReplayLabel(ago(rr.createdAt));
                                  setDockOpen(true);
                                  setShowRuns(false);
                                }}
                                title="Watch this run's recording"
                              >
                                <PlayCircle className="size-4 shrink-0 text-primary" />
                                <span className="flex-1 truncate">Run {ago(rr.createdAt)}</span>
                                <span className={cn("size-1.5 shrink-0 rounded-full", rr.status === "succeeded" ? "bg-emerald-500" : rr.status === "failed" ? "bg-destructive" : "bg-amber-500")} />
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })()}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!removeTarget}
        title={`Delete ${removeTarget?.name ?? "flow"}?`}
        message="This removes the flow and its run history. This can't be undone."
        confirmLabel="Delete"
        destructive
        busy={removing}
        onConfirm={onConfirmRemove}
        onCancel={() => setRemoveTarget(null)}
      />

      <ConfirmDialog
        open={!!forkTarget}
        title={`Fork "${forkTarget?.name ?? "flow"}"?`}
        message="This copies the flow into an editable, disabled draft and disconnects it from Settings — future Settings changes won't update the copy. The managed original is paused so the two can't double-fire."
        confirmLabel="Fork to customize"
        busy={forking}
        onConfirm={onForkConfirm}
        onCancel={() => setForkTarget(null)}
      />
    </>
  );
}
