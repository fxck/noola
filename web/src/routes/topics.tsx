import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Hash, TrendingUp, TrendingDown, Frown, ChevronRight, Flame, ArrowDownWideNarrow, Loader2, Wand2 } from "lucide-react";
import { type TopicSummary, type TopicTicket, fetchTopics, fetchTopicTickets, reclassifyTopics, topicLabel } from "@/lib/topics";
import { relativeTime } from "@/lib/tickets";
import { cn } from "@/lib/utils";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Menu, MenuItem } from "@/components/ui/menu";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toaster";

// Topics explorer — the "what are people contacting us about" view. Volume-ranked, each with a
// 14-day spark and a rising/falling trend so a lead can spot a surge (an outage, a broken release)
// before it shows up in the queue count.

// Trend-signed sparkline: line colored by direction (rising volume = amber warning, falling =
// evergreen), with a faint area fill so the shape reads at a glance, not just the last point.
function Sparkline({ data, trend }: { data: number[]; trend: number }) {
  const w = 96, h = 26, max = Math.max(1, ...data);
  const step = data.length > 1 ? w / (data.length - 1) : w;
  const pts = data.map((v, i) => [i * step, h - (v / max) * (h - 3) - 1.5] as const);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} ${w.toFixed(1)},${h} 0,${h}`;
  const last = pts[pts.length - 1];
  const tone = trend > 0 ? "text-warning" : trend < 0 ? "text-success" : "text-muted-foreground";
  return (
    <svg width={w} height={h} className={cn("overflow-visible", tone)} aria-hidden>
      <polygon points={area} fill="currentColor" className="opacity-[0.08]" />
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="opacity-90"
      />
      {last && <circle cx={last[0]} cy={last[1]} r="2" fill="currentColor" />}
    </svg>
  );
}

function Trend({ pct }: { pct: number }) {
  // Flat carries no signal — render nothing (the slot stays for alignment) rather than a dead "— flat".
  if (pct === 0) return null;
  const up = pct > 0;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${up ? "text-warning" : "text-success"}`}>
      {up ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />} {up ? "+" : ""}{pct}%
    </span>
  );
}

function TopicRow({ t }: { t: TopicSummary }) {
  const [open, setOpen] = useState(false);
  const [tickets, setTickets] = useState<TopicTicket[] | null>(null);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && tickets === null) fetchTopicTickets(t.topic).then(setTickets).catch(() => setTickets([]));
  }

  return (
    <li>
      <button onClick={toggle} className="flex w-full items-center gap-4 px-4 py-3 text-left hover:bg-muted/50">
        <ChevronRight className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{topicLabel(t.topic)}</span>
            {t.surge && (
              // Surge is the urgency that earns color (§9) — quiet warm text, never a chip.
              <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-warning">
                <Flame className="size-3" /> {t.surgeRatio}×
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span className="tabular-nums">{t.open} open</span>
            {t.negative > 0 && <span className="inline-flex items-center gap-1 text-warning"><Frown className="size-3" /> {t.negative} unhappy</span>}
            <span className="tabular-nums">{t.last14} in 14d</span>
          </div>
        </div>
        <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{t.total}</span>
        <Sparkline data={t.spark} trend={t.trend} />
        <div className="w-14 shrink-0 text-right"><Trend pct={t.trend} /></div>
      </button>

      {/* Drill-through: animate open/close via grid-rows 0fr→1fr + opacity (Emil) — no hard mount. */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200 [transition-timing-function:var(--ease-out-strong)] motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className={cn("overflow-hidden transition-opacity duration-200 motion-reduce:transition-none", open ? "opacity-100" : "opacity-0")}>
          {(open || tickets !== null) && (
          <div className="border-t bg-muted/20 px-4 py-2">
            {tickets === null ? (
              <div className="grid place-items-center py-4"><Spinner /></div>
            ) : tickets.length === 0 ? (
              <p className="py-3 text-sm text-muted-foreground">No tickets on this topic.</p>
            ) : (
              <ul className="divide-y">
                {tickets.map((tk) => (
                  <li key={tk.id}>
                    <Link to="/tickets/$ticketId" params={{ ticketId: tk.id }} className="flex items-center gap-3 py-2 hover:opacity-80">
                      <span className={`size-1.5 shrink-0 rounded-full ${tk.status === "open" ? "bg-primary" : "bg-muted-foreground/40"}`} />
                      <span className="min-w-0 flex-1 truncate text-sm">{tk.subject || "(no subject)"}</span>
                      {tk.sentiment === "negative" && <Frown className="size-3.5 shrink-0 text-warning" />}
                      <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(tk.created_at)}</span>
                    </Link>
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

type TopicSort = "volume" | "trending" | "open" | "negative";
const TOPIC_SORTS: { key: TopicSort; label: string }[] = [
  { key: "volume", label: "Volume" },
  { key: "trending", label: "Trending" },
  { key: "open", label: "Most open" },
  { key: "negative", label: "Most negative" },
];

/** The Topics section of the Analytics hub — owns its pane header (§3). */
export function TopicsView() {
  const [topics, setTopics] = useState<TopicSummary[] | null>(null);
  const [error, setError] = useState(false);
  const [sort, setSort] = useState<TopicSort>("volume");
  const [reclassifying, setReclassifying] = useState(false);

  const load = useCallback(() => {
    setTopics(null);
    setError(false);
    fetchTopics().then(setTopics).catch(() => setError(true));
  }, []);

  useEffect(() => { load(); }, [load]);

  const surges = (topics ?? []).filter((t) => t.surge);
  // The catch-all's share of total volume — high means classification is missing patterns.
  const generalShare = useMemo(() => {
    const all = topics ?? [];
    const total = all.reduce((a, t) => a + t.total, 0);
    if (total === 0) return null;
    const general = all.find((t) => t.topic === "general")?.total ?? 0;
    return Math.round((general / total) * 100);
  }, [topics]);

  async function reclassify() {
    setReclassifying(true);
    try {
      const r = await reclassifyTopics(300);
      if (r.reclassified === 0) {
        toast.success(`Scanned ${r.scanned} general ticket${r.scanned === 1 ? "" : "s"} — nothing reclassified.`);
      } else {
        const moved = Object.entries(r.byTopic)
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => `${topicLabel(k)} ${n}`)
          .join(", ");
        toast.success(`Moved ${r.reclassified} of ${r.scanned} scanned — ${moved}.`);
        load();
      }
    } catch (e) {
      const msg = e instanceof Error && /403/.test(e.message) ? "Admins only." : "Reclassify failed. Please try again.";
      toast.error(msg);
    } finally {
      setReclassifying(false);
    }
  }
  const sorted = useMemo(() => {
    const arr = [...(topics ?? [])];
    switch (sort) {
      case "trending":
        arr.sort((a, b) => b.trend - a.trend);
        break;
      case "open":
        arr.sort((a, b) => b.open - a.open);
        break;
      case "negative":
        arr.sort((a, b) => b.negative - a.negative);
        break;
      default:
        arr.sort((a, b) => b.total - a.total);
    }
    return arr;
  }, [topics, sort]);

  const sortLabel = TOPIC_SORTS.find((o) => o.key === sort)?.label ?? "Volume";

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 px-4">
        <h2 className="text-sm font-semibold tracking-tight">Topics</h2>
        {topics && (
          <span className="text-xs tabular-nums text-muted-foreground">{topics.length}</span>
        )}
        {generalShare != null && generalShare > 0 && (
          <span
            className={cn(
              "hidden text-xs sm:inline",
              generalShare >= 25 ? "font-medium text-warning" : "text-muted-foreground",
            )}
            title="Share of all tickets on the 'general' catch-all topic"
          >
            General absorbs {generalShare}%
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {topics && (topics.find((t) => t.topic === "general")?.total ?? 0) > 0 && (
            <button
              type="button"
              onClick={() => void reclassify()}
              disabled={reclassifying}
              className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-60"
              title="Re-run classification over the 'general' bucket"
            >
              {reclassifying ? <Loader2 className="size-3.5 animate-spin" /> : <Wand2 className="size-3.5" />}
              {reclassifying ? "Reclassifying…" : "Reclassify general"}
            </button>
          )}
          {topics && topics.length > 0 && (
            <Menu
              width={176}
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
                  <ArrowDownWideNarrow className="size-3.5" /> {sortLabel}
                </button>
              )}
            >
              {TOPIC_SORTS.map((o) => (
                <MenuItem
                  key={o.key}
                  label={o.label}
                  selected={sort === o.key}
                  onSelect={() => setSort(o.key)}
                />
              ))}
            </Menu>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {surges.length > 0 && (
          <div className="flex items-start gap-2.5 border-b border-warning/20 bg-warning/5 px-4 py-2.5">
            <Flame className="mt-0.5 size-4 shrink-0 text-warning" />
            <p className="text-sm">
              <span className="font-medium text-warning">
                {surges.length} topic{surges.length === 1 ? "" : "s"} surging
              </span>
              <span className="text-muted-foreground">
                {" "}— {surges.map((s) => `${topicLabel(s.topic)} (${s.surgeRatio}× vs prior 14d)`).join(", ")}
              </span>
            </p>
          </div>
        )}

        {error ? (
          <ErrorState title="Couldn't load topics" onRetry={load} />
        ) : !topics ? (
          <RowsSkeleton rows={8} />
        ) : topics.length === 0 ? (
          <EmptyState
            icon={Hash}
            title="No topics yet"
            description="They're assigned as tickets come in."
          />
        ) : (
          <ul className="divide-y">
            {sorted.map((t) => <TopicRow key={t.topic} t={t} />)}
          </ul>
        )}
      </div>
    </div>
  );
}
