import { useEffect, useState } from "react";
import { AlertTriangle, Bot, MessageCircleQuestion, Users, Wand2 } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { TAB_BASE, TAB_ON, TAB_OFF } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";
import { type ContainmentReport, fetchContainment } from "@/lib/analytics";

// The Containment section of the Analytics hub — the headline AI-support question:
// of everything customers asked, how much did AI absorb? Two lanes: deflected
// (answered publicly, no ticket ever existed) and the ticket funnel (AI-resolved →
// AI-assisted → human-only → untouched backlog).

// KPI card on the analytics KpiCard idiom (local — the route's component isn't exported).
function Kpi({ icon: Icon, label, value, sub }: {
  icon: typeof Bot; label: string; value: string; sub?: string;
}) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <div className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

// One muted tone per bucket — a single quiet ramp from "AI absorbed it" to "humans did".
const BUCKETS = [
  { key: "aiResolved", label: "AI-resolved", cls: "bg-primary" },
  { key: "aiAssisted", label: "AI-assisted", cls: "bg-primary/45" },
  { key: "humanOnly", label: "Human only", cls: "bg-foreground/30" },
  { key: "untouched", label: "No reply yet", cls: "bg-foreground/10" },
] as const;

/** Horizontal stacked composition of the handled/created ticket volume. */
function FunnelBar({ totals }: { totals: ContainmentReport["totals"] }) {
  const sum = totals.aiResolved + totals.aiAssisted + totals.humanOnly + totals.untouched;
  if (sum === 0) {
    return (
      <div className="flex h-10 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
        No conversations in this window.
      </div>
    );
  }
  return (
    <div>
      <div className="flex h-4 w-full overflow-hidden rounded-full">
        {BUCKETS.map((b) => {
          const v = totals[b.key];
          if (v === 0) return null;
          return (
            <div
              key={b.key}
              title={`${b.label}: ${v}`}
              className={cn("h-full", b.cls)}
              style={{ width: `${(v / sum) * 100}%` }}
            />
          );
        })}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
        {BUCKETS.map((b) => (
          <span key={b.key} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className={cn("size-2 rounded-full", b.cls)} />
            {b.label}
            <span className="tabular-nums font-medium text-foreground">{totals[b.key]}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Weekly stacked columns of the handled buckets, with the containment % on hover. */
function WeeklyChart({ data }: { data: ContainmentReport["byWeek"] }) {
  const max = Math.max(...data.map((w) => w.aiResolved + w.aiAssisted + w.humanOnly + w.untouched), 1);
  const hasData = data.some((w) => w.aiResolved + w.aiAssisted + w.humanOnly + w.untouched > 0);
  if (!hasData) {
    return (
      <div className="flex h-32 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
        No conversations in this window.
      </div>
    );
  }
  return (
    <div>
      <div className="flex h-32 items-stretch gap-1.5">
        {data.map((w) => {
          const total = w.aiResolved + w.aiAssisted + w.humanOnly + w.untouched;
          return (
            <div key={w.week} className="group relative flex flex-1 flex-col items-center justify-end">
              {total > 0 && (
                <>
                  {/* stack renders top-down: untouched sits on top, AI-resolved at the base */}
                  <div className="flex w-full flex-col-reverse overflow-hidden rounded-t" style={{ height: `${Math.max((total / max) * 100, 4)}%` }}>
                    {BUCKETS.map((b) => {
                      const v = w[b.key];
                      if (v === 0) return null;
                      return <div key={b.key} className={cn("w-full", b.cls)} style={{ height: `${(v / total) * 100}%` }} />;
                    })}
                  </div>
                  <div className="pointer-events-none absolute -top-6 whitespace-nowrap rounded bg-foreground px-1.5 py-0.5 text-micro font-medium tabular-nums text-background opacity-0 transition-opacity group-hover:opacity-100">
                    {w.containment != null ? `${w.containment}% contained` : "no handled tickets"} · {total} ticket{total === 1 ? "" : "s"} · wk {w.week.slice(5)}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between text-micro tabular-nums text-muted-foreground/60">
        <span>{data[0]?.week.slice(5)}</span>
        <span className="text-primary">this week</span>
      </div>
    </div>
  );
}

const WINDOWS = [4, 8, 12] as const;

/** The Containment section of the Analytics hub — how much demand AI absorbed. */
export function ContainmentView() {
  const [weeks, setWeeks] = useState<number>(8);
  const [data, setData] = useState<ContainmentReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = (w: number) => {
    setLoading(true);
    setError(false);
    fetchContainment(w).then(setData).catch(() => setError(true)).finally(() => setLoading(false));
  };
  useEffect(() => load(weeks), [weeks]);

  const t = data?.totals;

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 px-4">
        <h2 className="text-sm font-semibold tracking-tight">Containment</h2>
        <span className="hidden text-xs text-muted-foreground sm:inline">how much customer demand AI absorbed</span>
        <div className="ml-auto flex items-center gap-2">
          <div role="tablist" aria-label="Window" className="inline-flex items-center gap-0.5 rounded-lg border bg-muted/60 p-0.5">
            {WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
                role="tab"
                aria-selected={weeks === w}
                onClick={() => setWeeks(w)}
                className={cn(TAB_BASE, weeks === w ? TAB_ON : TAB_OFF)}
              >
                {w}w
              </button>
            ))}
          </div>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-4 pb-4">
          {loading && !data ? (
            <div className="grid place-items-center py-20"><Spinner /></div>
          ) : error && !data ? (
            <div className="flex flex-col items-center gap-3 py-20 text-center">
              <AlertTriangle className="size-7 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">Couldn't load the containment report.</p>
              <Button variant="outline" size="sm" onClick={() => load(weeks)}>Try again</Button>
            </div>
          ) : data && t ? (
            t.created === 0 && t.deflected === 0 ? (
              <EmptyState
                icon={Bot}
                title="No conversations in this window"
                description="Once customers write in (or ask the widget), the containment funnel shows how much of that demand AI absorbed."
              />
            ) : (
              <div className="space-y-5">
                {/* KPI row */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Kpi
                    icon={Wand2}
                    label="Containment"
                    value={t.containment != null ? `${t.containment}%` : "—"}
                    sub="handled conversations closed by AI alone"
                  />
                  <Kpi
                    icon={Bot}
                    label="AI-resolved"
                    value={String(t.aiResolved)}
                    sub={`+ ${t.aiAssisted} AI-assisted`}
                  />
                  <Kpi icon={Users} label="Human only" value={String(t.humanOnly)} sub={`of ${t.created} tickets created`} />
                  <Kpi
                    icon={MessageCircleQuestion}
                    label="Deflected"
                    value={String(t.deflected)}
                    sub={
                      t.deflectionShare != null
                        ? `${t.deflectionShare}% of demand answered before a ticket existed`
                        : "questions answered before a ticket existed"
                    }
                  />
                </div>

                {/* composition of the ticket volume */}
                <section className="rounded-xl border bg-card p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <h2 className="text-micro font-semibold uppercase tracking-wide text-muted-foreground">Where conversations ended up</h2>
                    <span className="text-micro tabular-nums text-muted-foreground">last {data.windowWeeks} weeks</span>
                  </div>
                  <FunnelBar totals={t} />
                </section>

                {/* weekly trend */}
                <section className="rounded-xl border bg-card p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <h2 className="text-micro font-semibold uppercase tracking-wide text-muted-foreground">Containment over time</h2>
                    <span className="text-micro tabular-nums text-muted-foreground">tickets per week, stacked by outcome</span>
                  </div>
                  <WeeklyChart data={data.byWeek} />
                </section>
              </div>
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}
