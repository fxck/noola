import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Bookmark, ChevronDown, Download, LineChart, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover } from "@/components/ui/popover";
import { PopoverSelect } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toaster";
import { TAB_BASE, TAB_ON, TAB_OFF } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";
import {
  type ReportConfig,
  type ReportMetricMeta,
  type ReportResult,
  type ReportSeries,
  type SavedReport,
  deleteSavedReport,
  fetchReportMetrics,
  fetchSavedReports,
  runReport,
  saveReport,
} from "@/lib/reports";
import { fetchTeams, type Team } from "@/lib/teams";
import { fetchUsers, type AgentUser } from "@/lib/tickets";

// ─────────────────────────────────────────────────────────────────────────────
// Reports — the report builder-lite section of the Analytics hub. Compose a
// metric set + window + filters in one config bar; the report runs itself
// (debounced) and renders as a totals row + small-multiples chart grid.
// Saved configs ride the segments store via lib/reports.
// ─────────────────────────────────────────────────────────────────────────────

const RANGE_PRESETS = [7, 28, 90] as const;
type RangePreset = (typeof RANGE_PRESETS)[number];
const METRIC_CAP = 8;
const DEFAULT_METRICS = ["volume", "closed", "ttfr_median", "csat_avg"];

// Group headers for the metric picker, in display order.
const UNIT_GROUPS: { unit: ReportMetricMeta["unit"]; label: string }[] = [
  { unit: "count", label: "Counts" },
  { unit: "hours", label: "Times" },
  { unit: "percent", label: "Rates" },
  { unit: "score", label: "Scores" },
];

function fmtHours(h: number): string {
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${Math.round(h * 10) / 10}h`;
  return `${Math.round(h / 24)}d`;
}

function fmtValue(v: number | null, unit: string): string {
  if (v == null) return "—";
  if (unit === "hours") return fmtHours(v);
  if (unit === "percent") return `${v.toFixed(1)}%`;
  if (unit === "score") return v.toFixed(1);
  return String(Math.round(v));
}

// Delta vs the previous period. Counts/percent read as relative change ("+12%");
// hours/score as an absolute signed delta ("−1.2h", "+0.3") — a relative change
// of a median time or a 1–5 score is harder to reason about than the raw shift.
function fmtDelta(cur: number, prev: number, unit: string): string {
  const d = cur - prev;
  const sign = d >= 0 ? "+" : "−";
  if (unit === "hours") return `${sign}${fmtHours(Math.abs(d))}`;
  if (unit === "score") return `${sign}${Math.abs(d).toFixed(1)}`;
  if (prev === 0) return "—"; // relative change against zero is meaningless
  const rel = (d / prev) * 100;
  return `${sign}${Math.abs(rel).toFixed(0)}%`;
}

// Direction semantics per unit: time metrics improve downward, rates/scores
// upward, raw counts (volume…) are neutral facts — color only where a direction
// is genuinely good/bad (§9: urgency/semantics earn color, nothing else does).
function deltaClass(cur: number, prev: number, unit: string): string {
  const d = cur - prev;
  if (d === 0 || unit === "count") return "text-muted-foreground";
  if (unit === "percent" && prev === 0) return "text-muted-foreground"; // fmtDelta shows "—" here
  const good = unit === "hours" ? d < 0 : d > 0;
  return good ? "text-success" : "text-destructive";
}

function exportCsv(result: ReportResult) {
  const esc = (v: string | number | null) =>
    v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v);
  const rows: (string | number | null)[][] = [
    ["bucket", ...result.series.map((s) => s.label)],
    ...result.buckets.map((b, i) => [b, ...result.series.map((s) => s.points[i] ?? null)]),
    ["total", ...result.series.map((s) => s.total)],
  ];
  const blob = new Blob([rows.map((r) => r.map(esc).join(",")).join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `report-${result.from.slice(0, 10)}-${result.to.slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// One mini bar chart per metric (small multiples — no combined multi-axis chart).
// Same hand-rolled idiom as the Overview VolumeChart: graphite bars, hairline
// gridlines, hover tooltip. Null points render as gaps (no bar, "—" tooltip).
function MetricChart({ series, buckets }: { series: ReportSeries; buckets: string[] }) {
  const vals = series.points.filter((p): p is number => p != null);
  const max = Math.max(...(vals.length ? vals : [0]));
  const scale = max > 0 ? max : 1;
  return (
    <section className="rounded-xl border bg-card p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h3 className="truncate text-micro font-semibold uppercase tracking-wide text-muted-foreground">{series.label}</h3>
        <span className="shrink-0 text-xs font-medium tabular-nums">{fmtValue(series.total, series.unit)}</span>
      </div>
      {vals.length === 0 ? (
        <div className="flex h-24 items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground">
          No data in this window.
        </div>
      ) : (
        <div>
          <div className="relative">
            <div className="pointer-events-none absolute inset-0 flex flex-col justify-between" aria-hidden>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="border-t border-border/60" />
              ))}
            </div>
            <div className="relative flex h-24 items-stretch gap-px sm:gap-0.5">
              {buckets.map((b, i) => {
                const v = series.points[i] ?? null;
                const h = v == null ? 0 : (v / scale) * 100;
                return (
                  <div key={b} className="group relative flex flex-1 flex-col items-center justify-end">
                    {v != null && (
                      <div
                        className="w-full rounded-t bg-foreground/20 transition-colors group-hover:bg-foreground/40"
                        style={{ height: `${Math.max(h, v > 0 ? 4 : 0)}%` }}
                      />
                    )}
                    <div className="pointer-events-none absolute -top-6 z-10 whitespace-nowrap rounded bg-foreground px-1.5 py-0.5 text-micro font-medium tabular-nums text-background opacity-0 transition-opacity group-hover:opacity-100">
                      {fmtValue(v, series.unit)} · {b.slice(5)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="mt-1.5 flex justify-between text-micro tabular-nums text-muted-foreground/60">
            <span>{buckets[0]?.slice(5)}</span>
            <span>{buckets[buckets.length - 1]?.slice(5)}</span>
          </div>
        </div>
      )}
    </section>
  );
}

// One stat card per selected metric — label, unit-formatted total, and (compare
// on) the delta vs the previous period.
function TotalCard({ series, prev, compare }: { series: ReportSeries; prev: number | null | undefined; compare: boolean }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">{series.label}</div>
      <div className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight">{fmtValue(series.total, series.unit)}</div>
      {compare && (
        <div
          className={cn(
            "mt-0.5 text-xs tabular-nums",
            series.total != null && prev != null ? deltaClass(series.total, prev, series.unit) : "text-muted-foreground",
          )}
          title="vs previous period"
        >
          {series.total != null && prev != null ? fmtDelta(series.total, prev, series.unit) : "—"}
          <span className="text-muted-foreground/60"> vs prev</span>
        </div>
      )}
    </div>
  );
}

// Metric multi-select — checkbox list in a popover, grouped by unit, capped at 8.
function MetricPicker({ catalog, values, onChange }: {
  catalog: ReportMetricMeta[];
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const atCap = values.length >= METRIC_CAP;
  const toggle = (key: string) =>
    onChange(values.includes(key) ? values.filter((v) => v !== key) : [...values, key]);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      width={236}
      trigger={
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="listbox"
          aria-expanded={open}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-dashed border-input bg-background px-2.5 text-xs font-medium transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <LineChart className="size-3.5 text-muted-foreground" />
          Metrics
          {values.length > 0 && (
            <span className="ml-0.5 rounded bg-primary/10 px-1.5 py-0.5 text-micro tabular-nums text-primary">{values.length}</span>
          )}
          <ChevronDown className="size-3 text-muted-foreground/50" />
        </button>
      }
    >
      <div className="max-h-80 overflow-y-auto p-1">
        {UNIT_GROUPS.map(({ unit, label }) => {
          const group = catalog.filter((m) => m.unit === unit);
          if (group.length === 0) return null;
          return (
            <div key={unit}>
              <div className="px-2 pb-1 pt-2 text-micro font-semibold uppercase tracking-wider text-muted-foreground/70">{label}</div>
              {group.map((m) => {
                const on = values.includes(m.key);
                const blocked = !on && atCap;
                return (
                  <button
                    key={m.key}
                    type="button"
                    disabled={blocked}
                    onClick={() => toggle(m.key)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-small transition-colors hover:bg-accent",
                      blocked && "pointer-events-none opacity-40",
                    )}
                  >
                    <Checkbox checked={on} className="pointer-events-none" tabIndex={-1} />
                    <span className="min-w-0 flex-1 truncate">{m.label}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="border-t px-2 py-1.5 text-micro tabular-nums text-muted-foreground">
        {values.length}/{METRIC_CAP} selected{atCap ? " · max reached" : ""}
      </div>
    </Popover>
  );
}

// The Saved menu — pick to load, x to delete.
function SavedMenu({ saved, onLoad, onDelete }: {
  saved: SavedReport[];
  onLoad: (r: SavedReport) => void;
  onDelete: (r: SavedReport) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      width={224}
      trigger={
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={open}
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Bookmark className="size-3.5" />
          Saved
          {saved.length > 0 && <span className="tabular-nums text-muted-foreground/70">{saved.length}</span>}
          <ChevronDown className="size-3 text-muted-foreground/50" />
        </button>
      }
    >
      <div className="max-h-72 overflow-y-auto p-1">
        {saved.length === 0 ? (
          <p className="px-2 py-3 text-center text-xs text-muted-foreground">No saved reports yet.</p>
        ) : (
          saved.map((r) => (
            <div key={r.id} className="group flex items-center gap-1 rounded-md transition-colors hover:bg-accent">
              <button
                type="button"
                onClick={() => {
                  onLoad(r);
                  setOpen(false);
                }}
                className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-small"
              >
                {r.name}
              </button>
              <button
                type="button"
                aria-label={`Delete “${r.name}”`}
                onClick={() => onDelete(r)}
                className="mr-1 rounded p-1 text-muted-foreground/50 opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover:opacity-100"
              >
                <X className="size-3" />
              </button>
            </div>
          ))
        )}
      </div>
    </Popover>
  );
}

// Inline name prompt for saving the current config.
function SaveButton({ onSave }: { onSave: (name: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    try {
      await onSave(n);
      setName("");
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      width={232}
      trigger={
        <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => setOpen((o) => !o)}>
          <Save className="size-3.5" /> Save
        </Button>
      }
    >
      <form
        className="flex items-center gap-1.5 p-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Report name…"
          className="h-8 text-xs"
        />
        <Button type="submit" size="sm" className="h-8 text-xs" disabled={!name.trim() || busy}>
          {busy ? <Spinner className="size-3.5" /> : "Save"}
        </Button>
      </form>
    </Popover>
  );
}

/** The Reports section of the Analytics hub — compose-and-read report canvas. */
export function ReportsView() {
  // ── config state ────────────────────────────────────────────────────────────
  const [metrics, setMetrics] = useState<string[]>(DEFAULT_METRICS);
  const [preset, setPreset] = useState<RangePreset>(28);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [compare, setCompare] = useState(false);

  // ── reference data ──────────────────────────────────────────────────────────
  const [catalog, setCatalog] = useState<ReportMetricMeta[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [agents, setAgents] = useState<AgentUser[]>([]);
  const [saved, setSaved] = useState<SavedReport[]>([]);
  useEffect(() => {
    fetchReportMetrics().then(setCatalog).catch(() => toast("Couldn't load the metric catalog.", { kind: "error" }));
    fetchTeams().then(setTeams).catch(() => {});
    fetchUsers().then(setAgents).catch(() => {});
    fetchSavedReports().then(setSaved).catch(() => {});
  }, []);

  // ── run the report (debounced, keep last result while refetching) ───────────
  const config: ReportConfig = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - preset * 86_400_000);
    return {
      metrics,
      from: from.toISOString(),
      to: to.toISOString(),
      groupBy: preset === 90 ? "week" : "day",
      teamId: teamId ?? undefined,
      agentId: agentId ?? undefined,
      compare,
    };
  }, [metrics, preset, teamId, agentId, compare]);

  const [result, setResult] = useState<ReportResult | null>(null);
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState(false);
  const reqRef = useRef(0);
  useEffect(() => {
    if (config.metrics.length === 0) {
      setResult(null);
      setFetching(false);
      return;
    }
    setFetching(true);
    setError(false);
    const id = ++reqRef.current;
    const t = setTimeout(() => {
      runReport(config)
        .then((r) => {
          if (reqRef.current !== id) return; // a newer config already ran
          setResult(r);
          setFetching(false);
        })
        .catch(() => {
          if (reqRef.current !== id) return;
          setError(true);
          setFetching(false);
        });
    }, 300);
    return () => clearTimeout(t);
  }, [config]);

  // ── saved reports ───────────────────────────────────────────────────────────
  const loadSaved = (r: SavedReport) => {
    const def = r.definition;
    setMetrics((def.metrics ?? []).slice(0, METRIC_CAP));
    // Saved windows are relative, not frozen: reverse-map the stored span to the
    // nearest preset and recompute from "now" — "last 28 days", not "June 7–Jul 5".
    let nearest: RangePreset = def.groupBy === "week" ? 90 : 28;
    if (def.from) {
      const end = def.to ? new Date(def.to).getTime() : Date.now();
      const days = Math.round((end - new Date(def.from).getTime()) / 86_400_000);
      nearest = RANGE_PRESETS.reduce((a, b) => (Math.abs(b - days) < Math.abs(a - days) ? b : a));
    }
    setPreset(nearest);
    setTeamId(def.teamId ?? null);
    setAgentId(def.agentId ?? null);
    setCompare(!!def.compare);
    toast(`Loaded “${r.name}”.`);
  };

  const handleSave = async (name: string) => {
    try {
      const created = await saveReport(name, config);
      setSaved((s) => [...s.filter((x) => x.id !== created.id), created]);
      toast(`Saved “${name}”.`, { kind: "ok" });
    } catch {
      toast("Couldn't save the report.", { kind: "error" });
      throw new Error("save failed"); // keep the prompt open
    }
  };

  const handleDelete = (r: SavedReport) => {
    deleteSavedReport(r.id)
      .then(() => {
        setSaved((s) => s.filter((x) => x.id !== r.id));
        toast(`Deleted “${r.name}”.`);
      })
      .catch(() => toast("Couldn't delete the saved report.", { kind: "error" }));
  };

  const prevTotals = useMemo(() => {
    const map = new Map<string, number | null>();
    for (const t of result?.compare?.totals ?? []) map.set(t.metric, t.total);
    return map;
  }, [result]);

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 px-4">
        <h2 className="text-sm font-semibold tracking-tight">Reports</h2>
        <span className="hidden text-xs text-muted-foreground sm:inline">pick metrics, a window and filters — the report runs itself</span>
        <div className="ml-auto flex items-center gap-2">
          {fetching && result && <Spinner className="size-3.5 text-muted-foreground" />}
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            disabled={!result || result.buckets.length === 0}
            onClick={() => result && exportCsv(result)}
          >
            <Download className="size-3.5" /> Export CSV
          </Button>
        </div>
      </header>

      {/* config bar — one row that wraps */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pb-3">
        <MetricPicker catalog={catalog} values={metrics} onChange={setMetrics} />
        <div role="tablist" aria-label="Date range" className="inline-flex items-center gap-0.5 rounded-lg border bg-muted/60 p-0.5">
          {RANGE_PRESETS.map((d) => (
            <button
              key={d}
              type="button"
              role="tab"
              aria-selected={preset === d}
              onClick={() => setPreset(d)}
              className={cn(TAB_BASE, preset === d ? TAB_ON : TAB_OFF)}
            >
              {d}d
            </button>
          ))}
        </div>
        <PopoverSelect
          value={teamId}
          onChange={setTeamId}
          align="start"
          options={[
            { value: null, label: "Any team" },
            ...teams.map((t) => ({ value: t.id, label: t.emoji ? `${t.emoji} ${t.name}` : t.name })),
          ]}
          buttonClassName="my-0 h-8 rounded-md border border-input bg-background px-2.5 text-xs"
        />
        <PopoverSelect
          value={agentId}
          onChange={setAgentId}
          align="start"
          options={[{ value: null, label: "Anyone" }, ...agents.map((a) => ({ value: a.id, label: a.name }))]}
          buttonClassName="my-0 h-8 rounded-md border border-input bg-background px-2.5 text-xs"
        />
        <div className="inline-flex h-8 select-none items-center gap-2 px-1 text-xs text-muted-foreground">
          <Switch checked={compare} onCheckedChange={setCompare} aria-label="Compare with previous period" />
          <button type="button" onClick={() => setCompare((c) => !c)} className="cursor-pointer transition-colors hover:text-foreground">
            Compare
          </button>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <SavedMenu saved={saved} onLoad={loadSaved} onDelete={handleDelete} />
          <SaveButton onSave={handleSave} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-4 pb-4">
          {metrics.length === 0 ? (
            <p className="py-20 text-center text-sm text-muted-foreground">Pick at least one metric to run a report.</p>
          ) : fetching && !result ? (
            <div className="grid place-items-center py-20"><Spinner /></div>
          ) : error && !result ? (
            <div className="flex flex-col items-center gap-3 py-20 text-center">
              <AlertTriangle className="size-7 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">Couldn't run the report.</p>
              {/* a fresh metrics array identity re-fires the debounced run effect */}
              <Button variant="outline" size="sm" onClick={() => setMetrics((m) => [...m])}>
                Try again
              </Button>
            </div>
          ) : result ? (
            // Keep the last result readable (dimmed) while a new config is in flight.
            <div className={cn("space-y-5 transition-opacity", fetching && "opacity-60")}>
              {/* totals row */}
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {result.series.map((s) => (
                  <TotalCard key={s.metric} series={s} prev={prevTotals.get(s.metric)} compare={compare && !!result.compare} />
                ))}
              </div>

              {/* small-multiples chart grid — shared bucket axis, one mini chart per metric */}
              {result.buckets.length === 0 ? (
                <div className="flex h-32 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
                  No data in this window.
                </div>
              ) : (
                <div className="grid gap-5 lg:grid-cols-2">
                  {result.series.map((s) => (
                    <MetricChart key={s.metric} series={s} buckets={result.buckets} />
                  ))}
                </div>
              )}

              <p className="text-micro tabular-nums text-muted-foreground/60">
                {result.from.slice(0, 10)} → {result.to.slice(0, 10)} · by {result.groupBy}
                {compare && result.compare ? ` · compared with ${result.compare.from.slice(0, 10)} → ${result.compare.to.slice(0, 10)}` : ""}
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
