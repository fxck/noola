import { useEffect, useMemo, useState } from "react";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { BarChart3, AlertTriangle, Download, Inbox, CheckCircle2, Bot, Clock, Hash, ClipboardCheck, Gauge, Timer, UserX, Activity, Star, FileBarChart, type LucideIcon } from "lucide-react";
import { TopicsView } from "@/routes/topics";
import { QualityView } from "@/routes/qa";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { PRIORITY_META } from "@/components/ticket-priority";
import type { TicketPriority } from "@/lib/tickets";
import { cn } from "@/lib/utils";
import { type AnalyticsOverview, type WorkloadReport, type SlaReport, fetchOverview, fetchWorkload, fetchSlaReport } from "@/lib/analytics";
import { CsatStars } from "@/components/csat-stars";
import { OpsView } from "@/components/analytics/ops-view";
import { CsatView } from "@/components/analytics/csat-view";
import { ReportsView } from "@/components/analytics/reports-view";
import { ContainmentView } from "@/components/analytics/containment-view";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { TAB_BASE, TAB_ON, TAB_OFF } from "@/components/ui/segmented";

function fmtHours(h: number | null): string {
  if (h == null) return "—";
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

// Avg / median / p90 for a timing metric (first-response or resolution). p90 surfaces the tail —
// the slow cases an average hides.
function TimingPanel({ title, avg, median, p90, count, countLabel }: {
  title: string;
  avg: number | null;
  median: number | null;
  p90: number | null;
  count: number;
  countLabel: string;
}) {
  const stats: [string, number | null][] = [["Average", avg], ["Median", median], ["p90", p90]];
  return (
    <section className="rounded-xl border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-micro font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
        <span className="text-micro tabular-nums text-muted-foreground">{count} {countLabel}</span>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {stats.map(([label, v]) => (
          <div key={label} className="rounded-lg border bg-background p-3 text-center">
            <div className="text-lg font-semibold tabular-nums">{fmtHours(v)}</div>
            <div className="mt-0.5 text-micro text-muted-foreground">{label}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

const PRIORITY_ORDER: TicketPriority[] = ["urgent", "high", "normal", "low"];

// The subset of the /tickets URL schema we can safely deep-link to (status, priority csv, team id,
// assignee id — "none" = unassigned for the latter two). Channel, language and per-day filters
// aren't in that route's validateSearch, so they don't drill through.
type TicketDrill = { status?: "open" | "closed" | "all"; priority?: string; team?: string; assignee?: string };

function KpiCard({ icon: Icon, label, value, sub, accent, drill, valueClass }: {
  icon: typeof Inbox; label: string; value: string; sub?: string; accent?: string; drill?: TicketDrill; valueClass?: string;
}) {
  const body = (
    <>
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="size-3.5" style={accent ? { color: accent } : undefined} />
        {label}
      </div>
      <div className={cn("mt-1.5 text-2xl font-semibold tabular-nums tracking-tight", valueClass)}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </>
  );
  if (drill) {
    return (
      <Link to="/tickets" search={drill} className="rounded-xl border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-muted/40">
        {body}
      </Link>
    );
  }
  return <div className="rounded-xl border bg-card p-4">{body}</div>;
}

// A compact 14-day volume bar chart — hand-rolled SVG, area-of-bars with an emphasized last day.
function VolumeChart({ data }: { data: { day: string; count: number }[] }) {
  // Densify to a continuous 14-day window so gaps read as zero, not as missing bars.
  const days = useMemo(() => {
    const byDay = new Map(data.map((d) => [d.day, d.count]));
    const out: { day: string; count: number }[] = [];
    const today = new Date();
    for (let i = 13; i >= 0; i--) {
      const dt = new Date(today);
      dt.setDate(today.getDate() - i);
      const key = dt.toISOString().slice(0, 10);
      out.push({ day: key, count: byDay.get(key) ?? 0 });
    }
    return out;
  }, [data]);
  const max = Math.max(1, ...days.map((d) => d.count));
  const hasData = days.some((d) => d.count > 0);
  if (!hasData) {
    return (
      <div className="flex h-32 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
        No new tickets in the last 14 days.
      </div>
    );
  }
  return (
    <div>
      <div className="relative">
        {/* Hairline gridlines behind the bars give the counts a baseline to read against. */}
        <div className="pointer-events-none absolute inset-0 flex flex-col justify-between" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="border-t border-border/60" />
          ))}
        </div>
        {/* items-stretch (not items-end) so each column fills h-32 and the bar's
            percentage height resolves against a real height instead of collapsing. */}
        <div className="relative flex h-32 items-stretch gap-1.5">
          {days.map((d, i) => {
            const last = i === days.length - 1;
            const h = (d.count / max) * 100;
            // Graphite/ink bars; the single amber bar is reserved for today (the one emphasis).
            return (
              <div key={d.day} className="group relative flex flex-1 flex-col items-center justify-end">
                <div
                  className={cn("w-full rounded-t transition-colors", last ? "bg-primary" : "bg-foreground/20 group-hover:bg-foreground/40")}
                  style={{ height: `${Math.max(h, d.count > 0 ? 4 : 0)}%` }}
                />
                <div className="pointer-events-none absolute -top-6 whitespace-nowrap rounded bg-foreground px-1.5 py-0.5 text-micro font-medium tabular-nums text-background opacity-0 transition-opacity group-hover:opacity-100">
                  {d.count} · {d.day.slice(5)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="mt-1.5 flex justify-between text-micro tabular-nums text-muted-foreground/60">
        <span>{days[0]?.day.slice(5)}</span>
        <span className="text-primary">today</span>
      </div>
    </div>
  );
}

function BreakdownBar({ label, count, total, hue, drill }: { label: string; count: number; total: number; hue: string; drill?: TicketDrill }) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  const inner = (
    <>
      <div className="w-24 shrink-0 truncate text-xs capitalize text-muted-foreground">{label}</div>
      <div className="h-4 flex-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full transition-[width] duration-300 [transition-timing-function:var(--ease-out-strong)]" style={{ width: `${Math.max(pct, count > 0 ? 3 : 0)}%`, background: hue }} />
      </div>
      <div className="w-8 shrink-0 text-right text-xs font-medium tabular-nums">{count}</div>
    </>
  );
  if (drill) {
    return (
      <Link to="/tickets" search={drill} className="-mx-1.5 flex items-center gap-3 rounded-md px-1.5 py-0.5 transition-colors hover:bg-muted/50">
        {inner}
      </Link>
    );
  }
  return <div className="flex items-center gap-3">{inner}</div>;
}

// A restrained categorical palette (desaturated, harmonized with the graphite ramp) for the
// channel/language breakdowns — amber stays reserved as signal, so it's intentionally absent here.
const CATEGORICAL = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--chart-6)", "var(--chart-7)", "var(--chart-8)"];

/** The Overview section of the Analytics hub — owns its pane header (§3). */
function OverviewView() {
  const [data, setData] = useState<AnalyticsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = () => {
    setLoading(true);
    setError(false);
    fetchOverview().then(setData).catch(() => setError(true)).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const priorityTotal = useMemo(() => (data?.byPriority ?? []).reduce((a, b) => a + b.count, 0), [data]);
  const channelMax = useMemo(() => Math.max(1, ...(data?.byChannel ?? []).map((c) => c.count)), [data]);
  const languageMax = useMemo(() => Math.max(1, ...(data?.byLanguage ?? []).map((l) => l.count)), [data]);
  const tagMax = useMemo(() => Math.max(1, ...(data?.topTags ?? []).map((t) => t.count)), [data]);
  const csatMax = useMemo(() => Math.max(1, ...(data?.csat?.distribution ?? []).map((d) => d.count)), [data]);

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 px-4">
        <h2 className="text-sm font-semibold tracking-tight">Overview</h2>
        <span className="text-xs text-muted-foreground">click a metric to open the matching tickets</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-4 pb-4">
          {loading && !data ? (
            <div className="grid place-items-center py-20"><Spinner /></div>
          ) : error ? (
            <div className="flex flex-col items-center gap-3 py-20 text-center">
              <AlertTriangle className="size-7 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">Couldn't load analytics.</p>
              <Button variant="outline" size="sm" onClick={load}>Try again</Button>
            </div>
          ) : data ? (
            <div className="space-y-5">
              {/* KPI row */}
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                <KpiCard icon={Inbox} label="Total" value={String(data.totals.total)} sub={`${data.totals.open} open`} drill={{ status: "all" }} />
                <KpiCard icon={CheckCircle2} label="Closed" value={String(data.totals.closed)} accent="var(--success)" drill={{ status: "closed" }} />
                <KpiCard icon={Bot} label="AI deflection" value={`${data.deflection.rate}%`} sub={`${data.deflection.aiMessages} AI replies`} accent="var(--primary)" />
                <KpiCard icon={Clock} label="Avg first response" value={fmtHours(data.responseTime?.avgHours ?? null)} sub={data.responseTime?.medianHours != null ? `median ${fmtHours(data.responseTime.medianHours)}` : undefined} />
                <KpiCard icon={Clock} label="Avg resolution" value={fmtHours(data.resolution.avgHours)} sub={data.resolution.medianHours != null ? `median ${fmtHours(data.resolution.medianHours)}` : undefined} />
              </div>

              {/* response + resolution time distribution */}
              {(data.responseTime || data.resolution) && (
                <div className="grid gap-5 lg:grid-cols-2">
                  <TimingPanel
                    title="Time to first response"
                    avg={data.responseTime?.avgHours ?? null}
                    median={data.responseTime?.medianHours ?? null}
                    p90={data.responseTime?.p90Hours ?? null}
                    count={data.responseTime?.respondedCount ?? 0}
                    countLabel="responded"
                  />
                  <TimingPanel
                    title="Time to resolution"
                    avg={data.resolution.avgHours}
                    median={data.resolution.medianHours}
                    p90={data.resolution.p90Hours ?? null}
                    count={data.resolution.closedCount}
                    countLabel="resolved"
                  />
                </div>
              )}

              {/* per-agent workload */}
              {data.byAgent && data.byAgent.length > 0 && (
                <section className="rounded-xl border bg-card p-4">
                  <h2 className="mb-3 text-micro font-semibold uppercase tracking-wide text-muted-foreground">By agent</h2>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-micro uppercase tracking-wide text-muted-foreground">
                          <th className="pb-2 pr-4 font-medium">Agent</th>
                          <th className="pb-2 pr-4 text-right font-medium tabular-nums">Assigned</th>
                          <th className="pb-2 pr-4 text-right font-medium tabular-nums">Closed</th>
                          <th className="pb-2 text-right font-medium tabular-nums">Avg resolution</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.byAgent.map((a) => (
                          <tr key={a.agentId} className="border-b last:border-0">
                            <td className="py-2 pr-4 font-medium">{a.agentName}</td>
                            <td className="py-2 pr-4 text-right tabular-nums">{a.assigned}</td>
                            <td className="py-2 pr-4 text-right tabular-nums">{a.closed}</td>
                            <td className="py-2 text-right tabular-nums text-muted-foreground">{fmtHours(a.avgResolutionHours)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              {/* volume */}
              <section className="rounded-xl border bg-card p-4">
                <h2 className="mb-3 text-micro font-semibold uppercase tracking-wide text-muted-foreground">New tickets · last 14 days</h2>
                <VolumeChart data={data.volume} />
              </section>

              <div className="grid gap-5 lg:grid-cols-2">
                {/* priority */}
                <section className="rounded-xl border bg-card p-4">
                  <h2 className="mb-3 text-micro font-semibold uppercase tracking-wide text-muted-foreground">By priority</h2>
                  <div className="space-y-2">
                    {PRIORITY_ORDER.map((p) => {
                      const row = data.byPriority.find((x) => x.priority === p);
                      return <BreakdownBar key={p} label={PRIORITY_META[p].label} count={row?.count ?? 0} total={priorityTotal} drill={{ status: "all", priority: p }} hue={PRIORITY_META[p].dot.startsWith("bg-red") ? "var(--destructive)" : PRIORITY_META[p].dot.startsWith("bg-amber") ? "var(--warning)" : PRIORITY_META[p].dot.startsWith("bg-slate-4") ? "var(--muted-foreground)" : "var(--border)"} />;
                    })}
                  </div>
                </section>

                {/* channel */}
                <section className="rounded-xl border bg-card p-4">
                  <h2 className="mb-3 text-micro font-semibold uppercase tracking-wide text-muted-foreground">By channel</h2>
                  {data.byChannel.length === 0 ? (
                    <p className="py-4 text-center text-xs text-muted-foreground">No data yet.</p>
                  ) : (
                    <div className="space-y-2">
                      {data.byChannel.map((c, i) => (
                        <BreakdownBar key={c.channel} label={c.channel} count={c.count} total={channelMax} hue={CATEGORICAL[i % CATEGORICAL.length]} />
                      ))}
                    </div>
                  )}
                </section>

                {/* language — detected customer language per ticket (guarded for older API responses) */}
                {data.byLanguage && (
                  <section className="rounded-xl border bg-card p-4">
                    <h2 className="mb-3 text-micro font-semibold uppercase tracking-wide text-muted-foreground">By language</h2>
                    {data.byLanguage.length === 0 ? (
                      <p className="py-4 text-center text-xs text-muted-foreground">No data yet.</p>
                    ) : (
                      <div className="space-y-2">
                        {data.byLanguage.map((l, i) => (
                          <BreakdownBar key={l.locale} label={l.label} count={l.count} total={languageMax} hue={CATEGORICAL[i % CATEGORICAL.length]} />
                        ))}
                      </div>
                    )}
                  </section>
                )}
              </div>

              {/* customer sentiment — guarded so an older API response can't crash the page */}
              {data.bySentiment && (
                <section className="rounded-xl border bg-card p-4">
                  <h2 className="mb-3 text-micro font-semibold uppercase tracking-wide text-muted-foreground">Customer sentiment</h2>
                  {(() => {
                    const total = data.bySentiment.positive + data.bySentiment.neutral + data.bySentiment.negative;
                    return total === 0 ? (
                      <p className="py-4 text-center text-xs text-muted-foreground">No classified tickets yet — sentiment is set from inbound customer messages.</p>
                    ) : (
                      <div className="space-y-2">
                        <BreakdownBar label="Positive" count={data.bySentiment.positive} total={total} hue="var(--success)" />
                        <BreakdownBar label="Neutral" count={data.bySentiment.neutral} total={total} hue="var(--muted-foreground)" />
                        <BreakdownBar label="Negative" count={data.bySentiment.negative} total={total} hue="var(--warning)" />
                      </div>
                    );
                  })()}
                </section>
              )}

              {/* CSAT — guarded so an older API response (no csat field) can't crash the page */}
              {data.csat && (
              <section className="rounded-xl border bg-card p-4">
                <h2 className="mb-3 text-micro font-semibold uppercase tracking-wide text-muted-foreground">Customer satisfaction</h2>
                {data.csat.responses === 0 ? (
                  <p className="py-4 text-center text-xs text-muted-foreground">
                    No CSAT responses yet — collected when customers rate a resolved ticket (via the API / widget).
                  </p>
                ) : (
                  <div className="grid gap-5 sm:grid-cols-[auto_1fr] sm:items-center">
                    <div className="flex flex-col items-center gap-1 sm:border-r sm:pr-6">
                      <div className="flex items-baseline gap-1">
                        <span className="text-3xl font-semibold tabular-nums tracking-tight">
                          {data.csat.average?.toFixed(1) ?? "—"}
                        </span>
                        <span className="text-sm text-muted-foreground">/ 5</span>
                      </div>
                      {data.csat.average != null && <CsatStars rating={Math.round(data.csat.average)} />}
                      <span className="text-xs text-muted-foreground">
                        {data.csat.responses} response{data.csat.responses === 1 ? "" : "s"} · {data.csat.positivePct}% positive
                      </span>
                    </div>
                    <div className="space-y-1.5">
                      {[5, 4, 3, 2, 1].map((r) => {
                        const row = data.csat.distribution.find((d) => d.rating === r);
                        return <BreakdownBar key={r} label={`${r} ★`} count={row?.count ?? 0} total={csatMax} hue="var(--warning)" />;
                      })}
                    </div>
                  </div>
                )}
              </section>
              )}

              {/* NPS — guarded so an older API response can't crash the page */}
              {data.nps && (
              <section className="rounded-xl border bg-card p-4">
                <h2 className="mb-3 text-micro font-semibold uppercase tracking-wide text-muted-foreground">Net Promoter Score</h2>
                {data.nps.responses === 0 ? (
                  <p className="py-4 text-center text-xs text-muted-foreground">
                    No NPS responses yet — collected via the public API (0–10 “how likely to recommend”).
                  </p>
                ) : (
                  <div className="grid gap-5 sm:grid-cols-[auto_1fr] sm:items-center">
                    <div className="flex flex-col items-center gap-1 sm:border-r sm:pr-6">
                      <span className={cn("text-3xl font-semibold tabular-nums tracking-tight",
                        (data.nps.score ?? 0) > 0 ? "text-emerald-600 dark:text-emerald-400" : (data.nps.score ?? 0) < 0 ? "text-red-600 dark:text-red-400" : "")}>
                        {data.nps.score ?? "—"}
                      </span>
                      <span className="text-xs text-muted-foreground">NPS · {data.nps.responses} response{data.nps.responses === 1 ? "" : "s"}</span>
                    </div>
                    <div className="space-y-1.5">
                      <BreakdownBar label="Promoters" count={data.nps.promoters} total={data.nps.responses} hue="var(--success)" />
                      <BreakdownBar label="Passives" count={data.nps.passives} total={data.nps.responses} hue="var(--warning)" />
                      <BreakdownBar label="Detractors" count={data.nps.detractors} total={data.nps.responses} hue="var(--destructive)" />
                    </div>
                  </div>
                )}
              </section>
              )}

              {/* tags */}
              <section className="rounded-xl border bg-card p-4">
                <h2 className="mb-3 text-micro font-semibold uppercase tracking-wide text-muted-foreground">Top tags</h2>
                {data.topTags.length === 0 ? (
                  <p className="py-4 text-center text-xs text-muted-foreground">No tags yet — add tags to tickets to segment them here.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {data.topTags.map((t) => (
                      <span key={t.tag} className="inline-flex items-center gap-1.5 rounded-full border bg-muted px-2.5 py-1 text-xs">
                        <span className="font-medium">{t.tag}</span>
                        <span className="tabular-nums text-muted-foreground" style={{ opacity: 0.5 + 0.5 * (t.count / tagMax) }}>{t.count}</span>
                      </span>
                    ))}
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

// An open-count cell that drills into the matching /tickets view — same quiet hover
// idiom as BreakdownBar (no link chrome at rest, a soft wash on hover).
function OpenDrillCell({ value, drill }: { value: number; drill: TicketDrill }) {
  return (
    <td className="py-2 pr-4 text-right tabular-nums">
      <Link to="/tickets" search={drill} className="-mx-1.5 rounded-md px-1.5 py-0.5 transition-colors hover:bg-muted/60">
        {value}
      </Link>
    </td>
  );
}

// The Waiting number is THE actionable one on the workload view (it's the queue that ages
// into SLA breaches) — amber only when non-zero, per the "urgency earns color" rule (§9).
function WaitingCell({ value }: { value: number }) {
  return (
    <td className={cn("py-2 pr-4 text-right tabular-nums", value > 0 ? "font-semibold text-warning" : "text-muted-foreground")}>
      {value}
    </td>
  );
}

/** The Workload section of the Analytics hub — live queue depth per agent and team. */
function WorkloadView() {
  const [data, setData] = useState<WorkloadReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = () => {
    setLoading(true);
    setError(false);
    fetchWorkload().then(setData).catch(() => setError(true)).finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
    // Quiet 30s refresh while this section is mounted — updates in place, no spinner flash.
    const t = setInterval(() => {
      fetchWorkload().then(setData).catch(() => {});
    }, 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 px-4">
        <h2 className="text-sm font-semibold tracking-tight">Workload</h2>
        <span className="text-xs text-muted-foreground">live queue per agent and team · refreshes every 30s</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-4 pb-4">
          {loading && !data ? (
            <div className="grid place-items-center py-20"><Spinner /></div>
          ) : error && !data ? (
            <div className="flex flex-col items-center gap-3 py-20 text-center">
              <AlertTriangle className="size-7 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">Couldn't load workload.</p>
              <Button variant="outline" size="sm" onClick={load}>Try again</Button>
            </div>
          ) : data ? (
            <div className="space-y-5">
              {/* totals */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <KpiCard icon={Inbox} label="Open" value={String(data.totals.open)} drill={{ status: "open" }} />
                <KpiCard icon={Clock} label="Waiting on us" value={String(data.totals.waiting)} sub="our turn to reply" accent={data.totals.waiting > 0 ? "var(--warning)" : undefined} />
                <KpiCard icon={UserX} label="Unassigned" value={String(data.totals.unassigned)} drill={{ assignee: "none", status: "open" }} />
              </div>

              {/* by team */}
              <section className="rounded-xl border bg-card p-4">
                <h2 className="mb-3 text-micro font-semibold uppercase tracking-wide text-muted-foreground">By team</h2>
                {data.byTeam.length === 0 ? (
                  <p className="py-4 text-center text-xs text-muted-foreground">
                    No teams yet — group agents into teams in{" "}
                    <Link to="/settings/teams" className="font-medium text-primary underline-offset-4 hover:underline">
                      Settings → Teams
                    </Link>.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-micro uppercase tracking-wide text-muted-foreground">
                          <th className="pb-2 pr-4 font-medium">Team</th>
                          <th className="pb-2 pr-4 text-right font-medium tabular-nums">Members</th>
                          <th className="pb-2 pr-4 text-right font-medium tabular-nums">Open</th>
                          <th className="pb-2 pr-4 text-right font-medium tabular-nums">Waiting</th>
                          <th className="pb-2 pr-4 text-right font-medium tabular-nums">Unassigned</th>
                          <th className="pb-2 text-right font-medium tabular-nums">Closed today</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.byTeam.map((t) => (
                          <tr key={t.teamId} className="border-b last:border-0">
                            <td className="py-2 pr-4 font-medium">
                              {t.emoji && <span className="mr-1.5">{t.emoji}</span>}
                              {t.teamName}
                            </td>
                            <td className="py-2 pr-4 text-right tabular-nums text-muted-foreground">{t.memberCount}</td>
                            <OpenDrillCell value={t.open} drill={{ team: t.teamId, status: "open" }} />
                            <WaitingCell value={t.waiting} />
                            <td className="py-2 pr-4 text-right tabular-nums">{t.unassigned}</td>
                            <td className="py-2 text-right tabular-nums text-muted-foreground">{t.closedToday}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {/* by agent — idle agents (0/0/0) are listed on purpose; imbalance is the point */}
              <section className="rounded-xl border bg-card p-4">
                <h2 className="mb-3 text-micro font-semibold uppercase tracking-wide text-muted-foreground">By agent</h2>
                {data.byAgent.length === 0 ? (
                  <p className="py-4 text-center text-xs text-muted-foreground">No agents yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-micro uppercase tracking-wide text-muted-foreground">
                          <th className="pb-2 pr-4 font-medium">Agent</th>
                          <th className="pb-2 pr-4 text-right font-medium tabular-nums">Open</th>
                          <th className="pb-2 pr-4 text-right font-medium tabular-nums">Waiting</th>
                          <th className="pb-2 text-right font-medium tabular-nums">Closed today</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.byAgent.map((a) => (
                          <tr key={a.agentId} className="border-b last:border-0">
                            <td className="py-2 pr-4">
                              <div className="flex items-center gap-1.5 font-medium">
                                {a.agentName}
                                {a.outOfOffice && (
                                  <Badge
                                    variant="muted"
                                    className="px-1.5 py-px text-micro"
                                    title={a.oooUntil ? `Back ${new Date(a.oooUntil).toLocaleString()}` : undefined}
                                  >
                                    Away
                                  </Badge>
                                )}
                              </div>
                              <div className="text-micro capitalize text-muted-foreground">{a.role}</div>
                            </td>
                            <OpenDrillCell value={a.open} drill={{ assignee: a.agentId, status: "open" }} />
                            <WaitingCell value={a.waiting} />
                            <td className="py-2 text-right tabular-nums text-muted-foreground">{a.closedToday}</td>
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

// Breached counts follow the WaitingCell convention — urgency earns color (§9), so a
// breach count is warm-red only when non-zero; a zero stays muted (it's not a signal).
function BreachCell({ value }: { value: number }) {
  return (
    <td className={cn("py-2 pr-4 text-right tabular-nums", value > 0 ? "font-semibold text-destructive" : "text-muted-foreground")}>
      {value}
    </td>
  );
}

// Weekly first-response met-vs-breached, on the VolumeChart idiom (stacked columns,
// hairline gridlines, hover tooltip). Met stays graphite — only the breach earns color.
function SlaWeeklyChart({ data }: { data: SlaReport["byWeek"] }) {
  const max = Math.max(1, ...data.map((w) => w.frMet + w.frBreached));
  const hasData = data.some((w) => w.frMet + w.frBreached > 0);
  if (!hasData) {
    return (
      <div className="flex h-32 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
        No first-response targets decided in this window.
      </div>
    );
  }
  return (
    <div>
      <div className="relative">
        <div className="pointer-events-none absolute inset-0 flex flex-col justify-between" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="border-t border-border/60" />
          ))}
        </div>
        <div className="relative flex h-32 items-stretch gap-1.5">
          {data.map((w) => {
            const metH = (w.frMet / max) * 100;
            const breachedH = (w.frBreached / max) * 100;
            return (
              <div key={w.week} className="group relative flex flex-1 flex-col items-center justify-end">
                {/* breached stacks on top of met so the column height reads as "decided" */}
                <div
                  className="w-full rounded-t bg-destructive/70 transition-colors group-hover:bg-destructive"
                  style={{ height: `${Math.max(breachedH, w.frBreached > 0 ? 4 : 0)}%` }}
                />
                <div
                  className={cn("w-full bg-foreground/20 transition-colors group-hover:bg-foreground/40", w.frBreached === 0 && "rounded-t")}
                  style={{ height: `${Math.max(metH, w.frMet > 0 ? 4 : 0)}%` }}
                />
                <div className="pointer-events-none absolute -top-6 whitespace-nowrap rounded bg-foreground px-1.5 py-0.5 text-micro font-medium tabular-nums text-background opacity-0 transition-opacity group-hover:opacity-100">
                  {w.frMet} met · {w.frBreached} breached · wk {w.week.slice(5)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="mt-1.5 flex justify-between text-micro tabular-nums text-muted-foreground/60">
        <span>{data[0]?.week.slice(5)}</span>
        <span>{data[data.length - 1]?.week.slice(5)}</span>
      </div>
    </div>
  );
}

const SLA_WINDOWS = [8, 12, 26] as const;

// Client-side CSV of the loaded SLA report — one flat table, a `section` column keeps
// the week/priority/team breakdowns apart (avg columns only apply to weeks).
function exportSlaCsv(report: SlaReport) {
  const esc = (v: string | number | null) =>
    v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v);
  const rows: (string | number | null)[][] = [
    ["section", "name", "tickets", "frMet", "frBreached", "resMet", "resBreached", "avgFrHours", "avgResHours"],
    ...report.byWeek.map((w) => ["week", w.week, w.tickets, w.frMet, w.frBreached, w.resMet, w.resBreached, w.avgFrHours, w.avgResHours]),
    ...report.byPriority.map((p) => ["priority", p.priority, p.tickets, p.frMet, p.frBreached, p.resMet, p.resBreached, null, null]),
    ...report.byTeam.map((t) => ["team", t.teamName, t.tickets, t.frMet, t.frBreached, t.resMet, t.resBreached, null, null]),
  ];
  const blob = new Blob([rows.map((r) => r.map(esc).join(",")).join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `sla-report-${report.windowWeeks}w.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/** The SLA section of the Analytics hub — target attainment over a trailing window. */
function SlaView() {
  const [weeks, setWeeks] = useState<number>(8);
  const [data, setData] = useState<SlaReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = (w: number) => {
    setLoading(true);
    setError(false);
    fetchSlaReport(w).then(setData).catch(() => setError(true)).finally(() => setLoading(false));
  };
  useEffect(() => load(weeks), [weeks]);

  const t = data?.totals;
  return (
    <div className="flex min-h-0 w-full min-w-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 px-4">
        <h2 className="text-sm font-semibold tracking-tight">SLA</h2>
        <span className="hidden text-xs text-muted-foreground sm:inline">first-response & resolution targets · business-hours aware</span>
        <div className="ml-auto flex items-center gap-2">
          <Link to="/tickets" search={{ sort: "sla" }} className="text-xs font-medium text-primary underline-offset-4 hover:underline">
            View tickets by SLA urgency
          </Link>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            disabled={loading || !data?.enabled}
            onClick={() => data && exportSlaCsv(data)}
          >
            <Download className="size-3.5" /> Export CSV
          </Button>
          <div role="tablist" aria-label="Window" className="inline-flex items-center gap-0.5 rounded-lg border bg-muted/60 p-0.5">
            {SLA_WINDOWS.map((w) => (
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
              <p className="text-sm text-muted-foreground">Couldn't load the SLA report.</p>
              <Button variant="outline" size="sm" onClick={() => load(weeks)}>Try again</Button>
            </div>
          ) : data && !data.enabled ? (
            <EmptyState
              icon={Timer}
              title="SLA policy is off"
              description={
                <>
                  Turn it on in{" "}
                  <Link to="/settings/sla" className="font-medium text-primary underline-offset-4 hover:underline">
                    Settings → SLA
                  </Link>{" "}
                  to set first-response and resolution targets — attainment reporting starts here once targets are being decided.
                </>
              }
            />
          ) : data && t ? (
            <div className="space-y-5">
              {/* attainment KPIs */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <KpiCard
                  icon={Timer}
                  label="First response met"
                  value={t.frRate != null ? `${t.frRate}%` : "—"}
                  sub={`${t.frMet} met · ${t.frBreached} breached`}
                  valueClass={t.frRate != null ? "text-success" : undefined}
                />
                <KpiCard
                  icon={CheckCircle2}
                  label="Resolution met"
                  value={t.resRate != null ? `${t.resRate}%` : "—"}
                  sub={`${t.resMet} met · ${t.resBreached} breached`}
                  valueClass={t.resRate != null ? "text-success" : undefined}
                />
              </div>
              {t.pending > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t.pending} ticket{t.pending === 1 ? "" : "s"} pending — neither target decided yet, not counted in the rates above.
                </p>
              )}

              {/* weekly first-response met vs breached */}
              <section className="rounded-xl border bg-card p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-micro font-semibold uppercase tracking-wide text-muted-foreground">First response · by week</h2>
                  <span className="flex items-center gap-3 text-micro text-muted-foreground">
                    <span className="flex items-center gap-1"><span className="size-2 rounded-sm bg-foreground/20" aria-hidden /> met</span>
                    <span className="flex items-center gap-1"><span className="size-2 rounded-sm bg-destructive/70" aria-hidden /> breached</span>
                  </span>
                </div>
                <SlaWeeklyChart data={data.byWeek} />
              </section>

              {/* by week */}
              <section className="rounded-xl border bg-card p-4">
                <h2 className="mb-3 text-micro font-semibold uppercase tracking-wide text-muted-foreground">By week</h2>
                {data.byWeek.length === 0 ? (
                  <p className="py-4 text-center text-xs text-muted-foreground">No tickets in this window.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-micro uppercase tracking-wide text-muted-foreground">
                          <th className="pb-2 pr-4 font-medium">Week of</th>
                          <th className="pb-2 pr-4 text-right font-medium tabular-nums">Tickets</th>
                          <th className="pb-2 pr-4 text-right font-medium tabular-nums">FR met</th>
                          <th className="pb-2 pr-4 text-right font-medium tabular-nums">FR breached</th>
                          <th className="pb-2 pr-4 text-right font-medium tabular-nums">Res met</th>
                          <th className="pb-2 pr-4 text-right font-medium tabular-nums">Res breached</th>
                          <th className="pb-2 pr-4 text-right font-medium tabular-nums">Avg FR</th>
                          <th className="pb-2 text-right font-medium tabular-nums">Avg res</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.byWeek.map((w) => (
                          <tr key={w.week} className="border-b last:border-0">
                            <td className="py-2 pr-4 font-medium tabular-nums">{w.week}</td>
                            <td className="py-2 pr-4 text-right tabular-nums">{w.tickets}</td>
                            <td className="py-2 pr-4 text-right tabular-nums">{w.frMet}</td>
                            <BreachCell value={w.frBreached} />
                            <td className="py-2 pr-4 text-right tabular-nums">{w.resMet}</td>
                            <BreachCell value={w.resBreached} />
                            <td className="py-2 pr-4 text-right tabular-nums text-muted-foreground">{fmtHours(w.avgFrHours)}</td>
                            <td className="py-2 text-right tabular-nums text-muted-foreground">{fmtHours(w.avgResHours)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {/* by priority */}
              <section className="rounded-xl border bg-card p-4">
                <h2 className="mb-3 text-micro font-semibold uppercase tracking-wide text-muted-foreground">By priority</h2>
                {data.byPriority.length === 0 ? (
                  <p className="py-4 text-center text-xs text-muted-foreground">No tickets in this window.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-micro uppercase tracking-wide text-muted-foreground">
                          <th className="pb-2 pr-4 font-medium">Priority</th>
                          <th className="pb-2 pr-4 text-right font-medium tabular-nums">Tickets</th>
                          <th className="pb-2 pr-4 text-right font-medium tabular-nums">FR met</th>
                          <th className="pb-2 pr-4 text-right font-medium tabular-nums">FR breached</th>
                          <th className="pb-2 pr-4 text-right font-medium tabular-nums">Res met</th>
                          <th className="pb-2 text-right font-medium tabular-nums">Res breached</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.byPriority.map((p) => (
                          <tr key={p.priority} className="border-b last:border-0">
                            <td className="py-2 pr-4 font-medium">{PRIORITY_META[p.priority as TicketPriority]?.label ?? p.priority}</td>
                            <td className="py-2 pr-4 text-right tabular-nums">{p.tickets}</td>
                            <td className="py-2 pr-4 text-right tabular-nums">{p.frMet}</td>
                            <BreachCell value={p.frBreached} />
                            <td className="py-2 pr-4 text-right tabular-nums">{p.resMet}</td>
                            <BreachCell value={p.resBreached} />
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {/* by team */}
              <section className="rounded-xl border bg-card p-4">
                <h2 className="mb-3 text-micro font-semibold uppercase tracking-wide text-muted-foreground">By team</h2>
                {data.byTeam.length === 0 ? (
                  <p className="py-4 text-center text-xs text-muted-foreground">No tickets in this window.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-micro uppercase tracking-wide text-muted-foreground">
                          <th className="pb-2 pr-4 font-medium">Team</th>
                          <th className="pb-2 pr-4 text-right font-medium tabular-nums">Tickets</th>
                          <th className="pb-2 pr-4 text-right font-medium tabular-nums">FR met</th>
                          <th className="pb-2 pr-4 text-right font-medium tabular-nums">FR breached</th>
                          <th className="pb-2 pr-4 text-right font-medium tabular-nums">Res met</th>
                          <th className="pb-2 text-right font-medium tabular-nums">Res breached</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.byTeam.map((tm) => (
                          <tr key={tm.teamId ?? "none"} className="border-b last:border-0">
                            <td className={cn("py-2 pr-4 font-medium", tm.teamId == null && "text-muted-foreground")}>{tm.teamName}</td>
                            <td className="py-2 pr-4 text-right tabular-nums">{tm.tickets}</td>
                            <td className="py-2 pr-4 text-right tabular-nums">{tm.frMet}</td>
                            <BreachCell value={tm.frBreached} />
                            <td className="py-2 pr-4 text-right tabular-nums">{tm.resMet}</td>
                            <BreachCell value={tm.resBreached} />
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

// ─────────────────────────────────────────────────────────────────────────────
// The Analytics hub — one Insight surface. Read-mostly sections over the same
// ticket corpus (Overview · Topics · Quality · Workload · SLA) live as an
// internal secondary column INSIDE the panel (STRUCTURE.md §2), each section
// owning its own h-12 pane header. Deep-linkable via ?view=.
// ─────────────────────────────────────────────────────────────────────────────
const analyticsRouteApi = getRouteApi("/analytics");

export type AnalyticsSection = "overview" | "ops" | "containment" | "topics" | "quality" | "workload" | "sla" | "csat" | "reports";

const SECTIONS: { key: AnalyticsSection; label: string; icon: LucideIcon }[] = [
  { key: "overview", label: "Overview", icon: BarChart3 },
  { key: "ops", label: "Ops", icon: Activity },
  { key: "containment", label: "Containment", icon: Bot },
  { key: "workload", label: "Workload", icon: Gauge },
  { key: "sla", label: "SLA", icon: Timer },
  { key: "csat", label: "CSAT", icon: Star },
  { key: "topics", label: "Topics", icon: Hash },
  { key: "quality", label: "Quality", icon: ClipboardCheck },
  { key: "reports", label: "Reports", icon: FileBarChart },
];

export function AnalyticsPage() {
  const navigate = useNavigate();
  const { view } = analyticsRouteApi.useSearch();
  const section: AnalyticsSection = view === "topics" || view === "quality" || view === "workload" || view === "sla" || view === "ops" || view === "containment" || view === "csat" || view === "reports" ? view : "overview";
  const select = (key: AnalyticsSection) =>
    void navigate({ to: "/analytics", search: key === "overview" ? {} : { view: key } });

  return (
    <>
      <div className="flex min-h-0 flex-1">
        {/* sections column — internal to the surface panel, behind a hairline */}
        <aside className="hidden w-44 shrink-0 flex-col border-r border-border/60 md:flex">
          <div className="flex h-12 shrink-0 items-center px-4">
            <h1 className="text-sm font-semibold tracking-tight">Analytics</h1>
          </div>
          <nav className="flex flex-col gap-0.5 px-2" aria-label="Analytics sections">
            {SECTIONS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => select(key)}
                aria-current={section === key ? "page" : undefined}
                className={cn(
                  "flex h-8 items-center gap-2 rounded-md px-2 text-left text-small transition-colors",
                  section === key
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                <Icon className="size-4 shrink-0" />
                <span className="truncate">{label}</span>
              </button>
            ))}
          </nav>
        </aside>

        {/* mobile section switch (the column is hidden below md) */}
        <div className="flex min-h-0 w-full min-w-0 flex-col">
          <div className="flex shrink-0 items-center gap-1 px-4 pt-2 md:hidden">
            {SECTIONS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => select(key)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs transition-colors",
                  section === key ? "bg-muted font-medium text-foreground" : "text-muted-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {section === "overview" ? <OverviewView /> : section === "ops" ? <OpsView /> : section === "containment" ? <ContainmentView /> : section === "topics" ? <TopicsView /> : section === "workload" ? <WorkloadView /> : section === "sla" ? <SlaView /> : section === "csat" ? <CsatView /> : section === "reports" ? <ReportsView /> : <QualityView />}
        </div>
      </div>
    </>
  );
}
