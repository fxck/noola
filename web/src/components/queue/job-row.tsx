import { Link } from "@tanstack/react-router";
import {
  Loader2,
  Check,
  CircleDashed,
  Pause,
  SkipForward,
  AlertTriangle,
  ArrowUpRight,
  Bot,
} from "lucide-react";
import type { JobItem, JobStatus, JobCounts } from "@/lib/autoreply";
import { relativeTime } from "@/lib/tickets";
import { DraftReceipt } from "@/components/queue/draft-receipt";
import { cn } from "@/lib/utils";

/**
 * A single autopilot job row + the shared status vocabulary (pill, count chips,
 * a compact "actively processing" chip for the inbox header). Status pills use
 * semantic colors kept distinct from each other; the "processing" spinner/pulse
 * only animates when the viewer allows motion.
 */

type Tone = "muted" | "accent" | "success" | "warning" | "danger";

const STATUS: Record<
  JobStatus,
  { label: string; tone: Tone; icon: typeof Check; spin?: boolean; pulse?: boolean }
> = {
  queued: { label: "Queued", tone: "muted", icon: CircleDashed },
  processing: { label: "Processing", tone: "accent", icon: Loader2, spin: true, pulse: true },
  sent: { label: "Sent", tone: "success", icon: Check },
  held: { label: "Held", tone: "warning", icon: Pause },
  skipped: { label: "Skipped", tone: "muted", icon: SkipForward },
  error: { label: "Error", tone: "danger", icon: AlertTriangle },
};

const TONE_PILL: Record<Tone, string> = {
  muted: "border-border bg-muted text-muted-foreground",
  accent: "border-primary/30 bg-primary/10 text-primary",
  success: "border-success/30 bg-success/10 text-success",
  warning: "border-warning/30 bg-warning/10 text-warning",
  danger: "border-destructive/30 bg-destructive/10 text-destructive",
};

const TONE_DOT: Record<Tone, string> = {
  muted: "bg-muted-foreground/50",
  accent: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
};

/** The status pill — muted → accent(+spinner) → semantic terminal color. */
export function JobStatusPill({ status, className }: { status: JobStatus; className?: string }) {
  const s = STATUS[status] ?? STATUS.queued;
  const Icon = s.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-micro font-medium leading-none",
        TONE_PILL[s.tone],
        className,
      )}
    >
      <Icon className={cn("size-3", s.spin && "motion-safe:animate-spin")} aria-hidden />
      {s.label}
    </span>
  );
}

/** The live counts summary — queued · processing · sent · held (+ skipped/error when present). */
export function JobCountChips({ counts }: { counts: JobCounts }) {
  // Quiet by default (§4): a zero count is the normal state and renders nothing.
  const items: { key: keyof JobCounts; label: string; tone: Tone }[] = [
    { key: "queued", label: "queued", tone: "muted" },
    { key: "processing", label: "processing", tone: "accent" },
    { key: "sent", label: "sent", tone: "success" },
    { key: "held", label: "held", tone: "warning" },
    { key: "skipped", label: "skipped", tone: "muted" },
    { key: "error", label: "error", tone: "danger" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {items
        .filter((it) => counts[it.key] > 0)
        .map((it) => {
          const n = counts[it.key];
          const active = it.key === "processing";
          return (
            <span
              key={it.key}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium leading-none tabular-nums",
                TONE_PILL[it.tone],
              )}
              title={`${n} ${it.label}`}
            >
              {active ? (
                <Loader2 className="size-2.5 motion-safe:animate-spin" aria-hidden />
              ) : (
                <span className={cn("size-1.5 rounded-full", TONE_DOT[it.tone])} aria-hidden />
              )}
              {n} {it.label}
            </span>
          );
        })}
    </div>
  );
}

/** A compact "autopilot is working" chip — for the inbox header. Renders only when active. */
export function AutopilotChip({ activeCount }: { activeCount: number }) {
  if (activeCount <= 0) return null;
  return (
    <Link
      to="/studio"
      search={{ view: "activity" }}
      title={`${activeCount} autopilot ${activeCount === 1 ? "job" : "jobs"} in flight`}
      className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium leading-none text-primary hover:bg-primary/15"
    >
      <Loader2 className="size-3 motion-safe:animate-spin" aria-hidden />
      Autopilot · {activeCount}
    </Link>
  );
}

const isActive = (s: JobStatus) => s === "queued" || s === "processing";

/** One job on the board: subject link · status pill · reason · timestamp · receipt. */
export function JobRow({ job, index = 0 }: { job: JobItem; index?: number }) {
  const active = isActive(job.status);
  const stamp = job.finished_at ?? job.started_at ?? job.created_at ?? null;

  return (
    <div
      className={cn(
        "motion-overlay rounded-xl border bg-card p-4 shadow-sm transition-colors",
        job.status === "processing" && "border-primary/30",
        job.status === "error" && "border-destructive/25",
      )}
      // Subtle staggered fade as rows mount/arrive (capped so long boards stay
      // quick). CSS animation runs once on mount — status re-renders keep the
      // same keyed node, so it never replays. `.motion-overlay` is opacity-only,
      // so reduced-motion keeps the fade without any positional motion.
      style={{ animationDelay: `${Math.min(index, 6) * 40}ms` }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            to="/"
            search={{ ticket: job.ticket_id }}
            className="inline-flex max-w-full items-center gap-1 text-sm font-medium text-foreground hover:text-primary hover:underline"
          >
            <span className="truncate">{job.ticket_subject || "Untitled ticket"}</span>
            <ArrowUpRight className="size-3.5 shrink-0 opacity-60" />
          </Link>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <JobStatusPill status={job.status} />
            {job.reason && !active && (
              <span
                className="font-mono text-micro text-muted-foreground"
                title="Why the auto-sender took this path"
              >
                {job.reason}
              </span>
            )}
            {stamp && <span className="text-xs text-muted-foreground">{relativeTime(stamp)}</span>}
          </div>
        </div>
      </div>

      {job.meta && <DraftReceipt meta={job.meta} className="mt-3" />}
    </div>
  );
}

/** Active-first ordering: processing, then queued (oldest first — next to drain),
 *  then finished rows newest-first. Keeps the top of the board "alive". */
export function sortJobs(jobs: JobItem[]): JobItem[] {
  const rank = (s: JobStatus) => (s === "processing" ? 0 : s === "queued" ? 1 : 2);
  return [...jobs].sort((a, b) => {
    const ra = rank(a.status);
    const rb = rank(b.status);
    if (ra !== rb) return ra - rb;
    if (ra === 2) {
      // finished — most recently finished at the top
      const fa = a.finished_at ?? a.created_at ?? "";
      const fb = b.finished_at ?? b.created_at ?? "";
      return fb.localeCompare(fa);
    }
    // active — oldest first so the queue visibly drains top-down
    return (a.created_at ?? "").localeCompare(b.created_at ?? "");
  });
}

/** The friendly empty state for the autopilot board. */
export function AutopilotEmpty() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed py-14 text-center">
      <span className="grid size-11 place-items-center rounded-full bg-muted text-muted-foreground">
        <Bot className="size-5" />
      </span>
      <div className="space-y-1">
        <p className="text-sm font-medium">No jobs running</p>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">
          Turn on Auto in Settings → Autoreply, or hit <span className="font-medium text-foreground">Run on backlog now</span>,
          to have the AI work through tickets that need a reply — you&rsquo;ll watch each job process here.
        </p>
      </div>
      <Link
        to="/settings/autoreply"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
      >
        <Bot className="size-3.5" /> Settings → Autoreply
      </Link>
    </div>
  );
}
