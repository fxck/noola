import { useEffect, useState, type ReactNode } from "react";
import { FlaskConical, Loader2, Play, ChevronRight, ShieldCheck } from "lucide-react";
import { type SimRun, type SimItem, fetchSimulations, fetchSimulation, runSimulation } from "@/lib/simulate";
import { relativeTime } from "@/lib/tickets";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toaster";

// Agent simulation — the readiness report. Run the AI over a sample of past tickets, then read
// three numbers that tell you whether to trust it: would-be QA score, auto-send rate (how often it
// would answer unattended), and coverage (how often it found grounding). Drill into a run to read
// the actual would-be answers.

function pct(n: number): string { return `${Math.round(n * 100)}%`; }
function scoreColor(n: number): string { return n >= 85 ? "text-success" : n >= 70 ? "text-success/80" : n >= 50 ? "text-warning" : "text-destructive"; }

// A small ring gauge (0..1 → arc) that carries the metric as shape; the number stays beside it.
function MiniRing({ ratio, tone }: { ratio: number; tone: string }) {
  const r = 12.5, c = 2 * Math.PI * r;
  const dash = Math.max(0, Math.min(1, ratio)) * c;
  return (
    <svg viewBox="0 0 32 32" className={cn("size-8 shrink-0 -rotate-90", tone)} aria-hidden>
      <circle cx="16" cy="16" r={r} fill="none" stroke="currentColor" strokeWidth="3" className="opacity-15" />
      <circle cx="16" cy="16" r={r} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeDasharray={`${dash.toFixed(2)} ${c.toFixed(2)}`} />
    </svg>
  );
}

function Stat({ label, value, ratio, tone }: { label: string; value: string; ratio: number; tone: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border bg-background px-3 py-2" title={`${label}: ${value}`}>
      <MiniRing ratio={ratio} tone={tone} />
      <div>
        <div className={cn("text-base font-semibold tabular-nums", tone)}>{value}</div>
        <div className="text-micro uppercase tracking-wide text-muted-foreground">{label}</div>
      </div>
    </div>
  );
}

function RunRow({ run }: { run: SimRun }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<SimItem[] | null>(null);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && items === null) fetchSimulation(run.id).then((r) => setItems(r.items)).catch(() => setItems([]));
  }

  return (
    <li>
      <button onClick={toggle} className="flex w-full items-center gap-4 px-4 py-3 text-left hover:bg-muted/50">
        <ChevronRight className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
        <div className="w-12 shrink-0 text-center">
          <div className={`text-xl font-semibold tabular-nums ${run.avg_score != null ? scoreColor(run.avg_score) : ""}`}>{run.avg_score ?? "—"}</div>
          <div className="text-micro uppercase text-muted-foreground">score</div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium">{run.label || `${run.sample_size}-ticket run`}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
            <span>{run.sample_size} tickets</span>
            <span>·</span>
            <span>auto-send {pct(run.auto_send_rate)}</span>
            <span>·</span>
            <span>coverage {pct(run.coverage)}</span>
            {run.model !== "rule" && <><span>·</span><span>{run.model}</span></>}
            <span>·</span>
            <span>{relativeTime(run.created_at)}</span>
          </div>
        </div>
      </button>

      {/* Drill-through: animate open/close via grid-rows 0fr→1fr + opacity (Emil) — no hard mount. */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200 [transition-timing-function:var(--ease-out-strong)] motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className={cn("overflow-hidden transition-opacity duration-200 motion-reduce:transition-none", open ? "opacity-100" : "opacity-0")}>
          {(open || items !== null) && (
          <div className="border-t bg-muted/20 px-4 py-2">
          {items === null ? (
            <div className="grid place-items-center py-4"><Spinner /></div>
          ) : items.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">No items in this run.</p>
          ) : (
            <ul className="divide-y">
              {items.map((it) => (
                <li key={it.ticket_id} className="py-2.5">
                  <div className="flex items-start gap-3">
                    <span className={`w-8 shrink-0 text-center text-sm font-semibold tabular-nums ${scoreColor(it.score)}`}>{it.score}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{it.subject || "(no subject)"}</span>
                        {it.would_auto_send ? (
                          <Badge variant="outline" className="shrink-0 gap-1 border-success/40 text-success"><ShieldCheck className="size-3" /> auto-send</Badge>
                        ) : (
                          <Badge variant="outline" className="shrink-0 text-muted-foreground">needs review</Badge>
                        )}
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground/70">Would answer:</span> {it.draft || "(no draft)"}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2.5 text-micro text-muted-foreground">
                        <span>{it.agreement} source{it.agreement === 1 ? "" : "s"}</span>
                        <span>·</span>
                        <span>{it.citations} citation{it.citations === 1 ? "" : "s"}</span>
                        {it.confidence != null && <><span>·</span><span>conf {it.confidence.toFixed(2)}</span></>}
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          </div>
          )}
        </div>
      </div>
    </li>
  );
}

/** Studio's Test bench — run the AI over past tickets, read the readiness report. */
export function TestBenchView({ viewSwitch }: { viewSwitch?: ReactNode }) {
  const [runs, setRuns] = useState<SimRun[] | null>(null);
  const [error, setError] = useState(false);
  const [size, setSize] = useState(10);
  const [running, setRunning] = useState(false);

  function load() {
    fetchSimulations().then(setRuns).catch(() => setError(true));
  }
  useEffect(load, []);

  async function run() {
    setRunning(true);
    try {
      const { run: r } = await runSimulation(size);
      toast.success(`Simulation complete — avg score ${r.avg_score ?? "—"}.`);
      load();
    } catch {
      toast.error("Couldn't run the simulation.");
    } finally { setRunning(false); }
  }

  const latest = runs?.[0];

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 px-4">
        <h2 className="text-sm font-semibold tracking-tight">Test bench</h2>
        <span className="hidden text-xs text-muted-foreground sm:inline">
          dry-run the AI on past tickets — no messages are sent
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {viewSwitch}
          <Menu
            width={160}
            trigger={(open, toggle) => (
              <button
                type="button"
                onClick={toggle}
                aria-haspopup="menu"
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
                  open && "bg-muted/60 text-foreground",
                )}
              >
                {size} tickets
              </button>
            )}
          >
            <MenuItem label="10 tickets" selected={size === 10} onSelect={() => setSize(10)} />
            <MenuItem label="25 tickets" selected={size === 25} onSelect={() => setSize(25)} />
          </Menu>
          <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={() => void run()} disabled={running}>
            {running ? <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> : <Play className="size-3.5" />}
            Run simulation
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-4 pb-4 pt-1">

          {latest && (
            <div className="mb-5">
              <div className="mb-2 flex items-center justify-between gap-3">
                <h2 className="text-micro font-semibold uppercase tracking-wide text-muted-foreground">Latest run</h2>
                <span className="text-micro text-muted-foreground">
                  {latest.label || `${latest.sample_size}-ticket run`} · {relativeTime(latest.created_at)}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Stat
                  label="Avg would-be score"
                  value={latest.avg_score != null ? String(latest.avg_score) : "—"}
                  ratio={(latest.avg_score ?? 0) / 100}
                  tone={latest.avg_score != null ? scoreColor(latest.avg_score) : "text-muted-foreground"}
                />
                <Stat label="Would auto-send" value={pct(latest.auto_send_rate)} ratio={latest.auto_send_rate} tone="text-success" />
                <Stat label="Grounding coverage" value={pct(latest.coverage)} ratio={latest.coverage} tone="text-muted-foreground" />
              </div>
              {latest.avg_score != null && (
                // Score-distribution strip: where this run's avg lands on the poor→excellent quality ramp.
                <div className="mt-3">
                  <div className="relative h-1.5 w-full rounded-full bg-gradient-to-r from-destructive/40 via-warning/40 to-success/50">
                    <div
                      className="absolute -top-[3px] size-3 -translate-x-1/2 rounded-full border-2 border-background bg-foreground shadow-sm"
                      style={{ left: `${Math.max(0, Math.min(100, latest.avg_score))}%` }}
                    />
                  </div>
                  <div className="mt-1 flex justify-between text-micro tabular-nums text-muted-foreground/60">
                    <span>0</span><span>poor</span><span>fair</span><span>good</span><span>100</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {error ? (
            <ErrorState title="Couldn't load simulations" onRetry={load} />
          ) : !runs ? (
            <RowsSkeleton rows={8} />
          ) : runs.length === 0 ? (
            <EmptyState
              icon={FlaskConical}
              title="No simulations yet"
              description="Run one to see how the AI would handle your tickets."
            />
          ) : (
            <ul className="divide-y overflow-hidden rounded-xl border">
              {runs.map((r) => <RunRow key={r.id} run={r} />)}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
