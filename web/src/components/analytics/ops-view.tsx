import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { AlarmClock, AlertTriangle, Clock, Inbox, PartyPopper, ShieldCheck, UserX } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { PRIORITY_META } from "@/components/ticket-priority";
import type { TicketPriority } from "@/lib/tickets";
import { initials, relativeTime } from "@/lib/tickets";
import { useRealtime } from "@/lib/realtime-context";
import { cn } from "@/lib/utils";
import { type OpsDashboard, type OpsTicketRef, fetchOps } from "@/lib/analytics";

// The subset of the /tickets URL schema we can safely deep-link to (mirrors the
// route's validateSearch — there is no whose_turn or snoozed param, so "Waiting on us"
// drills to plain open and Snoozed doesn't drill at all).
type TicketDrill = { status?: "open" | "closed" | "all"; assignee?: string };

// Same card as the other Analytics sections (Overview/Workload/SLA KpiCard idiom).
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

// "waiting 3h" from the shared relativeTime util ("3h ago" → "waiting 3h").
function waitingLabel(iso: string): string {
  const rel = relativeTime(iso);
  if (!rel) return "";
  return rel === "just now" ? rel : `waiting ${rel.replace(/\sago$/, "")}`;
}

// Due-time phrasing, mirroring the SlaBadge convention ("in 2h" / "2h over").
function untilLabel(dueAt: string): string {
  const ms = new Date(dueAt).getTime() - Date.now();
  if (Number.isNaN(ms)) return "";
  const abs = Math.abs(ms);
  const m = Math.round(abs / 60000);
  const txt = m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
  return ms < 0 ? `${txt} over` : `in ${txt}`;
}

// Priority as the row glyph vocabulary (dot + quiet label) — chips stay banned from rows (§4).
function PriorityGlyph({ priority }: { priority: string }) {
  const m = PRIORITY_META[priority as TicketPriority] ?? PRIORITY_META.normal;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" title={`Priority: ${m.label}`}>
      <span className={cn("size-1.5 rounded-full", m.dot)} aria-hidden />
      {m.label}
    </span>
  );
}

// SLA state per the SlaBadge convention: urgency earns COLOR (icon + tinted text), not a pill.
function SlaStateBadge({ state }: { state: string }) {
  if (state === "breached") {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-destructive">
        <AlertTriangle className="size-3.5" /> Breached
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-warning">
      <Clock className="size-3.5" /> At risk
    </span>
  );
}

// The ticket subject as a quiet drill-through into the routed conversation —
// same no-chrome-at-rest hover idiom as the other analytics drill cells.
function SubjectLink({ t }: { t: OpsTicketRef }) {
  return (
    <Link
      to="/tickets/$ticketId"
      params={{ ticketId: t.id }}
      className="-mx-1.5 rounded-md px-1.5 py-0.5 font-medium transition-colors hover:bg-muted/60"
    >
      {t.subject || "(no subject)"}
    </Link>
  );
}

// Quiet celebration for an empty queue — good news should read calm, not loud.
function QuietZero({ icon: Icon, children }: { icon: typeof PartyPopper; children: ReactNode }) {
  return (
    <p className="flex items-center justify-center gap-1.5 py-4 text-center text-xs text-muted-foreground">
      <Icon className="size-3.5 text-muted-foreground/60" aria-hidden />
      {children}
    </p>
  );
}

/**
 * The Ops section of the Analytics hub — "the live floor". Right-now queue depth,
 * who's online, the oldest customers still waiting on us, and the SLA targets about
 * to slip. Refreshes every 15s in place (no spinner flash, last data kept on error).
 */
export function OpsView() {
  const [data, setData] = useState<OpsDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // Presence rides the app-wide realtime layer (same source as the rail's
  // PresenceCluster). Outside the provider it degrades to an empty list and the
  // "Agents online" section simply doesn't render — no fake zeros.
  const { presence } = useRealtime();

  const load = () => {
    setLoading(true);
    setError(false);
    fetchOps().then(setData).catch(() => setError(true)).finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
    // Quiet 15s refresh while this section is mounted — updates in place; a failed
    // poll keeps the last snapshot rather than blanking the floor.
    const t = setInterval(() => {
      fetchOps().then(setData).catch(() => {});
    }, 15_000);
    return () => clearInterval(t);
  }, []);

  const oldestWaiting = data?.oldestWaiting ?? [];
  const breaching = data?.breaching ?? [];

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 px-4">
        <h2 className="text-sm font-semibold tracking-tight">Ops</h2>
        <span className="text-xs text-muted-foreground">the live floor · refreshes every 15s</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-4 pb-4">
          {loading && !data ? (
            <div className="grid place-items-center py-20"><Spinner /></div>
          ) : error && !data ? (
            <div className="flex flex-col items-center gap-3 py-20 text-center">
              <AlertTriangle className="size-7 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">Couldn't load the ops dashboard.</p>
              <Button variant="outline" size="sm" onClick={load}>Try again</Button>
            </div>
          ) : data ? (
            <div className="space-y-5">
              {/* queue KPIs — Waiting is THE actionable number (amber only when non-zero, §9) */}
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <KpiCard
                  icon={Clock}
                  label="Waiting on us"
                  value={String(data.queue.waiting)}
                  sub="our turn to reply"
                  accent={data.queue.waiting > 0 ? "var(--warning)" : undefined}
                  valueClass={data.queue.waiting > 0 ? "text-warning" : undefined}
                  drill={{ status: "open" }}
                />
                <KpiCard icon={UserX} label="Unassigned" value={String(data.queue.unassigned)} drill={{ assignee: "none", status: "open" }} />
                <KpiCard icon={Inbox} label="Open" value={String(data.queue.open)} drill={{ status: "open" }} />
                <KpiCard icon={AlarmClock} label="Snoozed" value={String(data.queue.snoozed)} sub="hidden until they wake" />
              </div>
              {/* the quiet second pair — today's flow, not a siren */}
              <p className="text-xs tabular-nums text-muted-foreground">
                Today: {data.today.created} new · {data.today.closed} closed
              </p>

              {/* agents online — same presence source as the rail cluster; renders only with signal */}
              {presence.length > 0 && (
                <section className="rounded-xl border bg-card p-4">
                  <div className="mb-3 flex items-center gap-2">
                    <h2 className="text-micro font-semibold uppercase tracking-wide text-muted-foreground">Agents online</h2>
                    <span className="size-1.5 rounded-full bg-success" aria-hidden />
                    <span className="text-micro tabular-nums text-muted-foreground">{presence.length}</span>
                  </div>
                  <div className="flex flex-wrap gap-x-5 gap-y-2">
                    {presence.map((u) => (
                      <span key={u.user_id} className="flex items-center gap-2" title={`${u.name} · online`}>
                        <span className="grid size-7 place-items-center rounded-full bg-accent text-micro font-semibold text-accent-foreground">
                          {initials(u.name)}
                        </span>
                        <span className="text-small">{u.name}</span>
                      </span>
                    ))}
                  </div>
                </section>
              )}

              {/* oldest waiting — the customers who have been in the queue longest */}
              <section className="rounded-xl border bg-card p-4">
                <h2 className="mb-3 text-micro font-semibold uppercase tracking-wide text-muted-foreground">Oldest waiting</h2>
                {oldestWaiting.length === 0 ? (
                  <QuietZero icon={PartyPopper}>Inbox zero — nothing waiting.</QuietZero>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-micro uppercase tracking-wide text-muted-foreground">
                          <th className="pb-2 pr-4 font-medium">Ticket</th>
                          <th className="pb-2 pr-4 font-medium">Contact</th>
                          <th className="pb-2 pr-4 font-medium">Team</th>
                          <th className="pb-2 pr-4 font-medium">Priority</th>
                          <th className="pb-2 text-right font-medium tabular-nums">Waiting</th>
                        </tr>
                      </thead>
                      <tbody>
                        {oldestWaiting.map((t) => (
                          <tr key={t.id} className="border-b last:border-0">
                            <td className="max-w-md truncate py-2 pr-4"><SubjectLink t={t} /></td>
                            <td className="py-2 pr-4 text-muted-foreground">{t.contactName ?? "—"}</td>
                            <td className="py-2 pr-4 text-muted-foreground">{t.teamName ?? "—"}</td>
                            <td className="py-2 pr-4"><PriorityGlyph priority={t.priority} /></td>
                            <td className="whitespace-nowrap py-2 text-right text-xs font-medium tabular-nums text-warning">
                              {waitingLabel(t.at)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {/* breaching soon — the SLA targets about to slip (or already gone) */}
              <section className="rounded-xl border bg-card p-4">
                <h2 className="mb-3 text-micro font-semibold uppercase tracking-wide text-muted-foreground">Breaching soon</h2>
                {!data.slaEnabled ? (
                  <p className="py-4 text-center text-xs text-muted-foreground">
                    SLA policy is off — turn it on in{" "}
                    <Link to="/settings/sla" className="font-medium text-primary underline-offset-4 hover:underline">
                      Settings → SLA
                    </Link>{" "}
                    to watch targets here.
                  </p>
                ) : breaching.length === 0 ? (
                  <QuietZero icon={ShieldCheck}>Nothing at risk — every target is on track.</QuietZero>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-micro uppercase tracking-wide text-muted-foreground">
                          <th className="pb-2 pr-4 font-medium">Ticket</th>
                          <th className="pb-2 pr-4 font-medium">Target</th>
                          <th className="pb-2 pr-4 font-medium">State</th>
                          <th className="pb-2 text-right font-medium tabular-nums">Due</th>
                        </tr>
                      </thead>
                      <tbody>
                        {breaching.map((t) => (
                          <tr key={`${t.id}:${t.target ?? ""}`} className="border-b last:border-0">
                            <td className="max-w-md truncate py-2 pr-4"><SubjectLink t={t} /></td>
                            <td className="py-2 pr-4 text-muted-foreground">
                              {t.target === "resolution" ? "Resolution" : "First response"}
                            </td>
                            <td className="py-2 pr-4"><SlaStateBadge state={t.state ?? "at_risk"} /></td>
                            <td className={cn(
                              "whitespace-nowrap py-2 text-right text-xs font-medium tabular-nums",
                              t.state === "breached" ? "text-destructive" : "text-warning",
                            )}>
                              {untilLabel(t.at)}
                            </td>
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
