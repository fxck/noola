import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, MessageSquare, Star, ThumbsUp } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { CsatStars } from "@/components/csat-stars";
import { cn } from "@/lib/utils";
import { type CsatReport, fetchCsatReport } from "@/lib/analytics";

// Same 3-branch formatting as analytics.tsx's fmtHours (not exported from there).
function fmtHours(h: number | null): string {
  if (h == null) return "—";
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

// KPI card on the analytics KpiCard idiom (local — the route's component isn't exported).
function Kpi({ icon: Icon, label, value, sub }: {
  icon: typeof Star; label: string; value: string; sub?: string;
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

// Weekly average rating on the VolumeChart/SlaWeeklyChart idiom — hand-rolled columns,
// hairline gridlines, hover tooltip. The 1–5 scale is absolute (a 4.2 week always draws
// at 84%), so integer gridlines mark the ratings themselves; the current week carries
// the single emphasis (primary), everything else stays graphite.
function CsatWeeklyChart({ data }: { data: CsatReport["byWeek"] }) {
  const hasData = data.some((w) => w.responses > 0);
  if (!hasData) {
    return (
      <div className="flex h-32 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
        No CSAT responses in this window.
      </div>
    );
  }
  return (
    <div>
      <div className="relative">
        {/* Faint gridlines at each rating (5 at the top, 1 near the baseline). */}
        <div className="pointer-events-none absolute inset-0" aria-hidden>
          {[5, 4, 3, 2, 1].map((r) => (
            <div
              key={r}
              className="absolute inset-x-0 border-t border-border/60"
              style={{ top: `${(1 - r / 5) * 100}%` }}
            />
          ))}
        </div>
        <div className="relative flex h-32 items-stretch gap-1.5">
          {data.map((w, i) => {
            const last = i === data.length - 1;
            const avg = w.responses > 0 ? w.average : null;
            const h = avg != null ? (avg / 5) * 100 : 0;
            // Weeks without responses render an empty slot — the column keeps its place
            // so the window stays continuous, but there's nothing to draw or hover.
            return (
              <div key={w.week} className="group relative flex flex-1 flex-col items-center justify-end">
                {avg != null && (
                  <>
                    <div
                      className={cn(
                        "w-full rounded-t transition-colors",
                        last ? "bg-primary" : "bg-foreground/20 group-hover:bg-foreground/40",
                      )}
                      style={{ height: `${Math.max(h, 4)}%` }}
                    />
                    <div className="pointer-events-none absolute -top-6 whitespace-nowrap rounded bg-foreground px-1.5 py-0.5 text-micro font-medium tabular-nums text-background opacity-0 transition-opacity group-hover:opacity-100">
                      {avg.toFixed(1)} · {w.responses} response{w.responses === 1 ? "" : "s"} · wk {w.week.slice(5)}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="mt-1.5 flex justify-between text-micro tabular-nums text-muted-foreground/60">
        <span>{data[0]?.week.slice(5)}</span>
        <span className="text-primary">this week</span>
      </div>
    </div>
  );
}

const CSAT_WINDOWS = [8, 12, 26] as const;

/** The CSAT section of the Analytics hub — satisfaction trend + agent leaderboard. */
export function CsatView() {
  const [weeks, setWeeks] = useState<number>(12);
  const [data, setData] = useState<CsatReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = (w: number) => {
    setLoading(true);
    setError(false);
    fetchCsatReport(w).then(setData).catch(() => setError(true)).finally(() => setLoading(false));
  };
  useEffect(() => load(weeks), [weeks]);

  // Overall average weighted by responses — a quiet week shouldn't count as much as a busy one.
  const totals = useMemo(() => {
    const byWeek = data?.byWeek ?? [];
    let responses = 0;
    let positive = 0;
    let weighted = 0;
    for (const w of byWeek) {
      responses += w.responses;
      positive += w.positive;
      if (w.average != null) weighted += w.average * w.responses;
    }
    return {
      responses,
      average: responses > 0 ? weighted / responses : null,
      positivePct: responses > 0 ? Math.round((positive / responses) * 100) : null,
    };
  }, [data]);

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 px-4">
        <h2 className="text-sm font-semibold tracking-tight">CSAT</h2>
        <span className="hidden text-xs text-muted-foreground sm:inline">satisfaction trend & agent leaderboard · from post-close surveys</span>
        <div className="ml-auto flex items-center gap-2">
          <SegmentedControl
            aria-label="Window"
            value={String(weeks)}
            onValueChange={(v) => setWeeks(Number(v))}
            options={CSAT_WINDOWS.map((w) => ({ value: String(w), label: `${w}w` }))}
          />
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-4 pb-4">
          {loading && !data ? (
            <div className="grid place-items-center py-20"><Spinner /></div>
          ) : error && !data ? (
            <div className="flex flex-col items-center gap-3 py-20 text-center">
              <AlertTriangle className="size-7 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">Couldn't load the CSAT report.</p>
              <Button variant="outline" size="sm" onClick={() => load(weeks)}>Try again</Button>
            </div>
          ) : data ? (
            <div className="space-y-5">
              {totals.responses === 0 ? (
                <EmptyState
                  icon={Star}
                  title="No CSAT responses in this window"
                  description={
                    <>
                      CSAT arrives from auto-surveys sent after tickets close — turn them on in{" "}
                      <Link to="/settings/surveys" className="font-medium text-primary underline-offset-4 hover:underline">
                        Settings → Surveys
                      </Link>{" "}
                      and ratings will start landing here.
                    </>
                  }
                />
              ) : (
                <>
                  {/* KPI row */}
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div className="rounded-xl border bg-card p-4">
                      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        <Star className="size-3.5" />
                        Average rating
                      </div>
                      <div className="mt-1.5 flex items-baseline gap-2">
                        <span className="text-2xl font-semibold tabular-nums tracking-tight">
                          {totals.average != null ? totals.average.toFixed(1) : "—"}
                        </span>
                        <span className="text-sm text-muted-foreground">/ 5</span>
                      </div>
                      {totals.average != null && <CsatStars rating={Math.round(totals.average)} className="mt-1" />}
                    </div>
                    <Kpi
                      icon={MessageSquare}
                      label="Responses"
                      value={String(totals.responses)}
                      sub={`last ${data.windowWeeks} weeks`}
                    />
                    <Kpi
                      icon={ThumbsUp}
                      label="Positive"
                      value={totals.positivePct != null ? `${totals.positivePct}%` : "—"}
                      sub="rated 4★ or higher"
                    />
                  </div>

                  {/* weekly average trend */}
                  <section className="rounded-xl border bg-card p-4">
                    <div className="mb-3 flex items-center justify-between">
                      <h2 className="text-micro font-semibold uppercase tracking-wide text-muted-foreground">CSAT over time</h2>
                      <span className="text-micro tabular-nums text-muted-foreground">avg rating per week · 1–5</span>
                    </div>
                    <CsatWeeklyChart data={data.byWeek} />
                  </section>
                </>
              )}

              {/* agent leaderboard — served sorted by closed DESC; zero-activity agents are
                  listed on purpose (the imbalance is the point, same as Workload). */}
              <section className="rounded-xl border bg-card p-4">
                <h2 className="mb-3 text-micro font-semibold uppercase tracking-wide text-muted-foreground">Agent leaderboard</h2>
                {data.leaderboard.length === 0 ? (
                  <p className="py-4 text-center text-xs text-muted-foreground">No agents yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-micro uppercase tracking-wide text-muted-foreground">
                          <th className="pb-2 pr-4 font-medium">Agent</th>
                          <th className="pb-2 pr-4 text-right font-medium tabular-nums">Closed</th>
                          <th className="pb-2 pr-4 text-right font-medium tabular-nums">CSAT</th>
                          <th className="pb-2 pr-4 text-right font-medium tabular-nums">Responses</th>
                          <th className="pb-2 text-right font-medium tabular-nums">Avg first response</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.leaderboard.map((a) => (
                          <tr key={a.agentId} className="border-b last:border-0">
                            <td className="py-2 pr-4 font-medium">{a.agentName}</td>
                            <td className="py-2 pr-4 text-right tabular-nums">{a.closed}</td>
                            <td className="py-2 pr-4 text-right">
                              {a.avgCsat != null ? (
                                <span className="inline-flex items-center justify-end gap-1.5">
                                  <CsatStars rating={Math.round(a.avgCsat)} />
                                  <span className="tabular-nums">{a.avgCsat.toFixed(1)}</span>
                                </span>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                            <td className="py-2 pr-4 text-right tabular-nums">{a.responses}</td>
                            <td className="py-2 text-right tabular-nums text-muted-foreground">{fmtHours(a.avgFirstResponseHours)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
