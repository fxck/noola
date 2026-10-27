import { Clock, AlertTriangle, CheckCircle2 } from "lucide-react";
import type { TicketSla, SlaTarget } from "@/lib/sla";
import { cn } from "@/lib/utils";

// A compact SLA indicator. Shows the most urgent of the two targets (first-response,
// resolution): a breach reads red, at-risk amber, otherwise a quiet countdown/met.

function rank(s: SlaTarget): number {
  return s.state === "breached" ? 3 : s.state === "at_risk" ? 2 : s.state === "ok" ? 1 : 0;
}

function untilLabel(dueAt: string): string {
  const ms = new Date(dueAt).getTime() - Date.now();
  const abs = Math.abs(ms);
  const m = Math.round(abs / 60000);
  const txt = m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
  return ms < 0 ? `${txt} over` : `in ${txt}`;
}

export function SlaBadge({
  sla,
  compact = false,
  className,
}: {
  sla: TicketSla | null | undefined;
  /** Row-density variant: bare icon + short time, only for at-risk/breached (else null). */
  compact?: boolean;
  className?: string;
}) {
  if (!sla) return null;
  // Worst of the two unmet targets drives the badge; if both met, show a quiet "met".
  const targets = [sla.firstResponse, sla.resolution];
  const worst = targets.reduce((a, b) => (rank(b) > rank(a) ? b : a));
  const allMet = targets.every((t) => t.state === "met");

  // Compact (triage-row) form: urgent states only, as bare short mono text —
  // no pill, no icon (STRUCTURE.md §4: loud-by-exception, quiet in form).
  if (compact) {
    if (worst.state !== "breached" && worst.state !== "at_risk") return null;
    const isBreach = worst.state === "breached";
    return (
      <span
        className={cn(
          "font-mono text-micro tabular-nums",
          isBreach ? "text-destructive" : "text-warning",
          className,
        )}
        title={`SLA — first response ${sla.firstResponse.state}, resolution ${sla.resolution.state}`}
      >
        {untilLabel(worst.dueAt)}
      </span>
    );
  }

  if (allMet) {
    return (
      <span className={cn("inline-flex items-center gap-1 text-xs text-success", className)} title="SLA met">
        <CheckCircle2 className="size-3.5" /> SLA met
      </span>
    );
  }

  const title = `First response ${sla.firstResponse.state}, resolution ${sla.resolution.state}`;

  // Quiet-by-default: far-from-due is a bare muted countdown (no pill chrome), so a
  // healthy queue reads calm; only at-risk (amber) and breached (red) earn a real pill.
  if (worst.state !== "breached" && worst.state !== "at_risk") {
    return (
      <span
        className={cn("inline-flex items-center gap-1 whitespace-nowrap text-xs tabular-nums text-muted-foreground", className)}
        title={title}
      >
        <Clock className="size-3.5" /> due {untilLabel(worst.dueAt)}
      </span>
    );
  }

  // Urgent states earn COLOR, not a pill — semantic tint on quiet text keeps
  // the detail rail calm while the breach still reads instantly.
  const meta =
    worst.state === "breached"
      ? { cls: "text-destructive", Icon: AlertTriangle, label: `${untilLabel(worst.dueAt)}` }
      : { cls: "text-warning", Icon: Clock, label: `due ${untilLabel(worst.dueAt)}` };

  return (
    <span
      className={cn("inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium tabular-nums", meta.cls, className)}
      title={title}
    >
      <meta.Icon className="size-3.5" /> {meta.label}
    </span>
  );
}
