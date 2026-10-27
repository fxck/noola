import { useEffect, useState } from "react";
import { Bot, Check, ChevronDown, CircleDashed, OctagonX, X } from "lucide-react";
import { type AgentRun, type AgentStep, fetchAgentRuns } from "@/lib/agent-runs";
import { relativeTime } from "@/lib/tickets";
import { RailSection } from "@/components/ui/rail";
import { cn } from "@/lib/utils";

// "Agent activity" rail section — the persisted trace of every autonomous-agent loop
// that ran on this ticket (manual "run agent" or an automation's agent node): what the
// agent did, step by step, and why it stopped. Self-hides when the ticket has no runs.

const SHOW_LIMIT = 5;

function stepLine(s: AgentStep): { icon: typeof Check; cls: string; text: string } {
  switch (s.kind) {
    case "action":
      return s.ok
        ? { icon: Check, cls: "text-success", text: `${s.tool}${s.detail ? ` — ${s.detail}` : ""}` }
        : { icon: X, cls: "text-destructive", text: `${s.tool} failed${s.detail ? ` — ${s.detail}` : ""}` };
    case "invalid":
      return { icon: CircleDashed, cls: "text-warning", text: `invalid response, retried${s.detail ? ` (${s.detail})` : ""}` };
    case "duplicate":
      return { icon: CircleDashed, cls: "text-muted-foreground", text: `duplicate ${s.tool ?? "action"} skipped` };
    case "error":
      return { icon: OctagonX, cls: "text-destructive", text: s.detail ?? "error" };
    case "limit":
      return { icon: CircleDashed, cls: "text-muted-foreground", text: s.detail ?? "stopped" };
    default: // done
      return { icon: Check, cls: "text-muted-foreground", text: s.detail ? `done — ${s.detail}` : "done" };
  }
}

function RunRow({ run }: { run: AgentRun }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="py-1.5 first:pt-0 last:pb-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md text-left text-small focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            run.status === "error" ? "bg-destructive" : "bg-success",
          )}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate">
          {run.source === "manual" ? "Manual run" : "Automation"}
          {run.dry_run && (
            <span className="ml-1.5 rounded bg-muted/70 px-1 py-px text-micro font-medium text-muted-foreground">
              dry run
            </span>
          )}
        </span>
        <span className="shrink-0 text-micro tabular-nums text-muted-foreground">
          {relativeTime(run.created_at)}
        </span>
        <ChevronDown
          className={cn("size-3 shrink-0 text-muted-foreground/60 transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <div className="mt-1.5 space-y-1 pl-3.5">
          {run.instructions && (
            <p className="line-clamp-2 text-xs italic text-muted-foreground">“{run.instructions}”</p>
          )}
          <ul className="space-y-1">
            {run.steps.map((s, i) => {
              const m = stepLine(s);
              const Icon = m.icon;
              return (
                <li key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  <Icon className={cn("mt-0.5 size-3 shrink-0", m.cls)} />
                  <span className="line-clamp-2 min-w-0">{m.text}</span>
                </li>
              );
            })}
          </ul>
          <p className="text-micro text-muted-foreground/60">{run.model}</p>
        </div>
      )}
    </li>
  );
}

/** Fetches on ticket change; renders its own RailSection only when runs exist. */
export function AgentRunsSection({ ticketId }: { ticketId: string }) {
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let live = true;
    setShowAll(false);
    fetchAgentRuns(ticketId)
      .then((r) => live && setRuns(r))
      .catch(() => live && setRuns([]));
    return () => {
      live = false;
    };
  }, [ticketId]);

  if (runs.length === 0) return null;
  const visible = showAll ? runs : runs.slice(0, SHOW_LIMIT);

  return (
    <RailSection id="agent-runs" icon={Bot} title="Agent activity" count={runs.length}>
      <ul className="flex flex-col divide-y divide-border/40">
        {visible.map((r) => (
          <RunRow key={r.id} run={r} />
        ))}
      </ul>
      {runs.length > SHOW_LIMIT && !showAll && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="pt-1 text-xs font-medium text-primary underline-offset-4 hover:underline"
        >
          Show all {runs.length}
        </button>
      )}
    </RailSection>
  );
}
