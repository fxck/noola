import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ClipboardCheck, RefreshCw, Loader2, Sparkles } from "lucide-react";
import { type QaScore, type QaBand, type QaSummary, type QaAgentRow, type QaCsatCorrelation, BAND_META, BANDS, fetchQa, rescoreTicket, backfillQa, fetchQaAgents, fetchQaCorrelation } from "@/lib/qa";
import { relativeTime } from "@/lib/tickets";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { TAB_BASE, TAB_ON, TAB_OFF, TAB_BADGE } from "@/components/ui/segmented";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toaster";

// Conversation QA — the review surface. A lead scans the weakest-scored conversations, sees the
// three sub-scores + a one-line rationale, and can re-score after a change. Scoring is automatic on
// close, so this is mostly read; the backfill action seeds it on an empty tenant.

// §9 color discipline: semantic red is reserved for the failing band (<50). Mid scores
// stay muted (amber-free), good scores stay quiet — the ring shape carries them, not tint.
function scoreColor(n: number): string {
  if (n >= 70) return "text-foreground";
  if (n >= 50) return "text-muted-foreground";
  return "text-destructive";
}

// Sub-scores read as shape, not digits: a 3-segment meter filled + tinted by band. The exact number
// stays on hover (title) for the lead who wants it.
function SubScore({ label, value }: { label: string; value: number }) {
  const tone = scoreColor(value);
  const filled = value > 0 ? Math.max(1, Math.round((value / 100) * 3)) : 0;
  return (
    <div className="flex w-10 flex-col items-center gap-1" title={`${label}: ${value}`}>
      <div className="flex gap-0.5">
        {[0, 1, 2].map((i) => (
          <span key={i} className={cn("h-1.5 w-2.5 rounded-[1px]", i < filled ? cn(tone, "bg-current") : "bg-muted")} />
        ))}
      </div>
      <span className="text-micro uppercase tracking-wide text-muted-foreground">{label}</span>
    </div>
  );
}

// Overall score as a small inline ring gauge (0–100 → arc), number centered, band by color.
function ScoreRing({ value, band }: { value: number; band: QaBand }) {
  const r = 15.5, c = 2 * Math.PI * r;
  const dash = Math.max(0, Math.min(100, value)) / 100 * c;
  const tone = scoreColor(value);
  return (
    <div className={cn("relative size-11", tone)} title={`${BAND_META[band].label} · ${value}/100`}>
      <svg viewBox="0 0 40 40" className="size-11 -rotate-90">
        <circle cx="20" cy="20" r={r} fill="none" stroke="currentColor" strokeWidth="3.5" className="opacity-15" />
        <circle cx="20" cy="20" r={r} fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeDasharray={`${dash.toFixed(2)} ${c.toFixed(2)}`} />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-sm font-semibold tabular-nums">{value}</span>
    </div>
  );
}

/** The Quality section of the Analytics hub — owns its pane header (§3). */
export function QualityView() {
  const [scores, setScores] = useState<QaScore[] | null>(null);
  const [summary, setSummary] = useState<QaSummary | null>(null);
  const [error, setError] = useState(false);
  const [band, setBand] = useState<QaBand | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // ticket_id being re-scored, or "backfill"
  const [agents, setAgents] = useState<QaAgentRow[]>([]);
  const [corr, setCorr] = useState<QaCsatCorrelation | null>(null);

  const load = useCallback((b: QaBand | null) => {
    setScores(null); setError(false);
    fetchQa(b ?? undefined).then((r) => { setScores(r.scores); setSummary(r.summary); }).catch(() => setError(true));
  }, []);

  const loadInsights = useCallback(() => {
    fetchQaAgents().then(setAgents).catch(() => setAgents([]));
    fetchQaCorrelation().then(setCorr).catch(() => setCorr(null));
  }, []);

  useEffect(() => { load(band); }, [band, load]);
  useEffect(() => { loadInsights(); }, [loadInsights]);

  async function rescore(id: string) {
    setBusy(id);
    try {
      await rescoreTicket(id);
      toast.success("Conversation re-scored.");
      load(band); loadInsights();
    } catch {
      toast.error("Couldn't re-score that conversation.");
    } finally { setBusy(null); }
  }

  async function backfill() {
    setBusy("backfill");
    try {
      const n = await backfillQa();
      toast.success(n > 0 ? `Scored ${n} conversation${n === 1 ? "" : "s"}.` : "Nothing new to score.");
      load(band); loadInsights();
    } catch {
      toast.error("Couldn't score conversations.");
    } finally { setBusy(null); }
  }

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 px-4">
        <h2 className="text-sm font-semibold tracking-tight">Quality</h2>
        {summary && summary.scored > 0 && (
          <span className="text-xs tabular-nums text-muted-foreground">
            avg{" "}
            <span className={cn("font-semibold", summary.avgOverall != null && scoreColor(summary.avgOverall))}>
              {summary.avgOverall ?? "—"}
            </span>
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {summary && summary.scored > 0 && (
            <div
              role="tablist"
              aria-label="Score band"
              className="inline-flex items-center gap-0.5 rounded-lg border bg-muted/60 p-0.5"
            >
              <button
                type="button"
                role="tab"
                aria-selected={band === null}
                onClick={() => setBand(null)}
                className={cn(TAB_BASE, band === null ? TAB_ON : TAB_OFF)}
              >
                All <span className={TAB_BADGE}>{summary.scored}</span>
              </button>
              {BANDS.map((b) => (
                <button
                  key={b}
                  type="button"
                  role="tab"
                  aria-selected={band === b}
                  onClick={() => setBand(band === b ? null : b)}
                  className={cn(TAB_BASE, band === b ? TAB_ON : TAB_OFF)}
                >
                  {BAND_META[b].label} <span className={TAB_BADGE}>{summary.byBand[b]}</span>
                </button>
              ))}
            </div>
          )}
          <Button size="sm" variant="outline" className="h-8 shrink-0 gap-1.5 text-xs" onClick={() => void backfill()} disabled={busy === "backfill"}>
            {busy === "backfill" ? <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> : <Sparkles className="size-3.5" />}
            Score conversations
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-4 pb-4 pt-1">
          {(agents.length > 0 || (corr && corr.pairs > 0)) && (
            <div className="mb-5 grid gap-3 md:grid-cols-2">
              {agents.length > 0 && (
                <section className="rounded-xl border bg-card p-4">
                  <h3 className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Coaching — by agent</h3>
                  <ul className="space-y-2">
                    {agents.map((a) => (
                      <li key={a.agentId} className="flex items-center gap-3">
                        <span className={`w-8 shrink-0 text-right text-sm font-semibold tabular-nums ${scoreColor(a.avgOverall)}`}>{a.avgOverall}</span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">{a.agentName}</div>
                          <div className="text-micro text-muted-foreground">
                            {a.scored} scored · res {a.avgResolution} · tone {a.avgTone} · compl {a.avgCompleteness}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {BANDS.map((b) => a.byBand[b] > 0 && (
                            <span key={b} className="inline-flex items-center gap-0.5 text-micro text-muted-foreground" title={BAND_META[b].label}>
                              <span className="size-1.5 rounded-full" style={{ background: BAND_META[b].dot }} />{a.byBand[b]}
                            </span>
                          ))}
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {corr && corr.pairs > 0 && (
                <section className="rounded-xl border bg-card p-4">
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Does QA track CSAT?</h3>
                  <p className="mb-3 text-xs text-muted-foreground">{corr.pairs} conversation{corr.pairs === 1 ? "" : "s"} with both a QA score and a customer rating.</p>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div className="rounded-lg border bg-background p-2.5">
                      <div className="text-micro uppercase tracking-wide text-muted-foreground">Avg QA · happy (4-5★)</div>
                      <div className={`text-lg font-semibold tabular-nums ${corr.avgQaWhenHappy != null ? scoreColor(corr.avgQaWhenHappy) : ""}`}>{corr.avgQaWhenHappy ?? "—"}</div>
                    </div>
                    <div className="rounded-lg border bg-background p-2.5">
                      <div className="text-micro uppercase tracking-wide text-muted-foreground">Avg QA · unhappy (1-2★)</div>
                      <div className={`text-lg font-semibold tabular-nums ${corr.avgQaWhenUnhappy != null ? scoreColor(corr.avgQaWhenUnhappy) : ""}`}>{corr.avgQaWhenUnhappy ?? "—"}</div>
                    </div>
                    <div className="rounded-lg border bg-background p-2.5">
                      <div className="text-micro uppercase tracking-wide text-muted-foreground">Avg CSAT · high QA (≥70)</div>
                      <div className="text-lg font-semibold tabular-nums">{corr.avgCsatWhenHighQa != null ? `${corr.avgCsatWhenHighQa}★` : "—"}</div>
                    </div>
                    <div className="rounded-lg border bg-background p-2.5">
                      <div className="text-micro uppercase tracking-wide text-muted-foreground">Avg CSAT · low QA (&lt;70)</div>
                      <div className="text-lg font-semibold tabular-nums">{corr.avgCsatWhenLowQa != null ? `${corr.avgCsatWhenLowQa}★` : "—"}</div>
                    </div>
                  </div>
                </section>
              )}
            </div>
          )}

          {error ? (
            <ErrorState title="Couldn't load QA scores" onRetry={() => load(band)} />
          ) : !scores ? (
            <RowsSkeleton rows={8} />
          ) : scores.length === 0 ? (
            <EmptyState
              icon={ClipboardCheck}
              title={band ? "No conversations in this band" : "No scored conversations yet"}
              description={band ? undefined : "Close a ticket, or use “Score conversations” to seed scores."}
            />
          ) : (
            <ul className="divide-y overflow-hidden rounded-xl border">
              {scores.map((s) => (
                // Whole row is the target (absolute-inset Link); interactive children sit above it.
                <li key={s.ticket_id} className="group relative flex items-center gap-4 px-4 py-3 hover:bg-muted/50">
                  <Link
                    to="/tickets/$ticketId" params={{ ticketId: s.ticket_id }}
                    aria-label={`Open ${s.subject || "conversation"}`}
                    className="absolute inset-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  />
                  <div className="pointer-events-none relative shrink-0">
                    <ScoreRing value={s.overall} band={s.band} />
                  </div>
                  <div className="pointer-events-none relative min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium group-hover:underline">
                      {s.subject || "(no subject)"}
                    </span>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                      <span className="capitalize">{s.status}</span>
                      {s.assignee_name && <><span className="text-muted-foreground/40">·</span><span>{s.assignee_name}</span></>}
                      <span className="text-muted-foreground/40">·</span>
                      <span>{relativeTime(s.scored_at)}</span>
                    </div>
                    {s.rationale && <p className="mt-0.5 truncate text-xs text-muted-foreground/80">{s.rationale}</p>}
                  </div>
                  <div className="pointer-events-none relative hidden shrink-0 items-center gap-3 sm:flex">
                    <SubScore label="Res" value={s.resolution} />
                    <SubScore label="Tone" value={s.tone} />
                    <SubScore label="Compl" value={s.completeness} />
                  </div>
                  <Button
                    variant="ghost" size="icon" className="relative shrink-0 text-muted-foreground hover:text-foreground"
                    title="Re-score" onClick={(e) => { e.preventDefault(); e.stopPropagation(); void rescore(s.ticket_id); }} disabled={busy === s.ticket_id}
                  >
                    {busy === s.ticket_id ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> : <RefreshCw className="size-4" />}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
