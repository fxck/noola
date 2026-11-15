import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Bot, Percent, SearchX, ShieldBan, Undo2, Users } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { TAB_BASE, TAB_ON, TAB_OFF } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";
import { type SpamReport, fetchSpamReport } from "@/lib/analytics";

// The Spam section of the Analytics hub: how much spam arrives, who hid it, and where the AI spam check got it wrong.

// KPI card on the analytics KpiCard idiom (local - the route's component isn't exported).
function Kpi({ icon: Icon, label, value, sub, toSpamFolder }: {
  icon: typeof Bot; label: string; value: string; sub?: string; toSpamFolder?: boolean;
}) {
  const body = (
    <>
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <div className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </>
  );
  if (toSpamFolder) {
    return (
      <Link
        to="/tickets"
        search={{ status: "spam" }}
        title="Open the Spam folder"
        className="rounded-xl border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-muted/40"
      >
        {body}
      </Link>
    );
  }
  return <div className="rounded-xl border bg-card p-4">{body}</div>;
}

const BUCKETS = [
  { key: "byAi", label: "Hidden by AI", cls: "bg-primary" },
  { key: "byTeam", label: "Marked by the team", cls: "bg-foreground/30" },
] as const;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Weekly stacked columns of hidden spam, split by who hid it. */
function WeeklyChart({ data }: { data: SpamReport["byWeek"] }) {
  const max = Math.max(...data.map((w) => w.hidden), 1);
  if (!data.some((w) => w.hidden > 0)) {
    return (
      <div className="flex h-32 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
        No spam in this window.
      </div>
    );
  }
  return (
    <div>
      <div className="flex h-32 items-stretch gap-1.5">
        {data.map((w) => (
          <div key={w.week} className="group relative flex flex-1 flex-col items-center justify-end">
            {w.hidden > 0 && (
              <>
                <div className="flex w-full flex-col-reverse overflow-hidden rounded-t" style={{ height: `${Math.max((w.hidden / max) * 100, 4)}%` }}>
                  {BUCKETS.map((b) => {
                    const v = w[b.key];
                    if (v === 0) return null;
                    return <div key={b.key} className={cn("w-full", b.cls)} style={{ height: `${(v / w.hidden) * 100}%` }} />;
                  })}
                </div>
                <div className="pointer-events-none absolute -top-6 whitespace-nowrap rounded bg-foreground px-1.5 py-0.5 text-micro font-medium tabular-nums text-background opacity-0 transition-opacity group-hover:opacity-100">
                  {w.hidden} hidden · {w.byAi} by AI · {w.outreach} outreach · wk {w.week.slice(5)}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-micro tabular-nums text-muted-foreground/60">
        <span>{data[0]?.week.slice(5)}</span>
        <span>{data[data.length - 1]?.week.slice(5)}</span>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
        {BUCKETS.map((b) => (
          <span key={b.key} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className={cn("size-2 rounded-full", b.cls)} />
            {b.label}
          </span>
        ))}
      </div>
    </div>
  );
}

const WINDOWS = [4, 8, 12] as const;

export function SpamView() {
  const [weeks, setWeeks] = useState<number>(8);
  const [data, setData] = useState<SpamReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // A response for a window that is no longer picked is dropped.
  const latest = useRef(0);
  const load = (w: number) => {
    const seq = ++latest.current;
    setLoading(true);
    setError(false);
    fetchSpamReport(w)
      .then((r) => seq === latest.current && setData(r))
      .catch(() => seq === latest.current && setError(true))
      .finally(() => seq === latest.current && setLoading(false));
  };
  useEffect(() => load(weeks), [weeks]);

  const t = data?.totals;

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 px-4">
        <h2 className="text-sm font-semibold tracking-tight">Spam</h2>
        <span className="hidden text-xs text-muted-foreground sm:inline">how much spam arrives and who hid it</span>
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
              <p className="text-sm text-muted-foreground">Couldn't load the spam report.</p>
              <Button variant="outline" size="sm" onClick={() => load(weeks)}>Try again</Button>
            </div>
          ) : data && t ? (
            t.hidden === 0 && t.checked === 0 && t.restored === 0 ? (
              <EmptyState
                icon={ShieldBan}
                title="No spam in this window"
                description="Once your team or the AI marks conversations as spam, this shows how much arrives and who hid it."
              />
            ) : (
              <div className="space-y-5">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <Kpi
                    icon={ShieldBan}
                    label="Spam per day"
                    value={String(t.perDay)}
                    sub={`${t.perWeek} per week · ${t.outreach} outreach in total`}
                    toSpamFolder
                  />
                  <Kpi
                    icon={Percent}
                    label="Share of new conversations"
                    value={t.share != null ? `${t.share}%` : "—"}
                    sub={`${t.hidden} of ${t.created} conversations`}
                  />
                  <Kpi
                    icon={Bot}
                    label="Hidden by AI"
                    value={String(t.byAi)}
                    sub="by the spam check on new emails"
                  />
                  <Kpi icon={Users} label="Marked by the team" value={String(t.byTeam)} />
                  <Kpi icon={SearchX} label="Missed by AI" value={String(t.missedByAi)} sub="judged legit, then marked as spam by the team" />
                  <Kpi
                    icon={Undo2}
                    label="Marked as not spam"
                    value={String(t.restored)}
                    sub={`${t.restoredFromAi} of them hidden by AI`}
                  />
                </div>

                {t.checked > 0 && (
                  <p className="text-sm text-muted-foreground">
                    The AI checked {plural(t.checked, "email")}: missed {t.missedByAi}, hid {t.restoredFromAi} by mistake.
                  </p>
                )}

                <section className="rounded-xl border bg-card p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <h2 className="text-micro font-semibold uppercase tracking-wide text-muted-foreground">Spam over time</h2>
                    <span className="text-micro tabular-nums text-muted-foreground">hidden per week, outreach included</span>
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
