import { Loader2 } from "lucide-react";
import { useQueue } from "@/lib/queue-context";
import { useJobs } from "@/lib/jobs-context";

/**
 * The live trailing badges for the "Queue" nav item: a count of pending approval
 * drafts, and — while autopilot is working — a spinner + active-job count. Two
 * distinct, non-overlapping signals. Renders nothing when both are zero.
 */
export function QueueBadge() {
  const { count } = useQueue();
  const { activeCount } = useJobs();
  if (count === 0 && activeCount === 0) return null;
  return (
    <span className="flex items-center gap-1">
      {count > 0 && (
        <span
          className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary/15 px-1 text-micro font-semibold leading-none tabular-nums text-primary"
          aria-label={`${count} pending approval`}
        >
          {count > 99 ? "99+" : count}
        </span>
      )}
      {activeCount > 0 && (
        <span
          className="inline-flex items-center gap-0.5 rounded-full bg-primary/15 px-1 py-0.5 text-micro font-semibold leading-none tabular-nums text-primary"
          aria-label={`${activeCount} autopilot jobs running`}
          title={`${activeCount} autopilot ${activeCount === 1 ? "job" : "jobs"} in flight`}
        >
          <Loader2 className="size-2.5 motion-safe:animate-spin" aria-hidden />
          {activeCount}
        </span>
      )}
    </span>
  );
}
