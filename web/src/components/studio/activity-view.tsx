import { useState, type ReactNode } from "react";
import { Play, Loader2 } from "lucide-react";
import { useJobs } from "@/lib/jobs-context";
import { runAutopilot } from "@/lib/autoreply";
import { JobRow, JobCountChips, AutopilotEmpty, sortJobs } from "@/components/queue/job-row";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toaster";

/**
 * Studio's Activity view — the live autopilot board (absorbed from the old
 * /queue surface): watch the AI work through tickets that need a reply, and
 * kick a backlog run. Automation observability lives WITH the automations.
 */
export function ActivityView({ viewSwitch }: { viewSwitch?: ReactNode }) {
  const jobs = useJobs();
  const [running, setRunning] = useState(false);

  async function onRun() {
    if (running) return;
    setRunning(true);
    try {
      const { queued } = await runAutopilot();
      jobs.refetch();
      toast.success(
        queued > 0
          ? `Queued ${queued} ${queued === 1 ? "ticket" : "tickets"} for autopilot.`
          : "Nothing to do — no tickets are waiting on a reply.",
      );
    } catch {
      toast.error("Couldn't start autopilot. Is Auto mode available?");
    } finally {
      setRunning(false);
    }
  }

  const sorted = sortJobs(jobs.jobs);

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 px-4">
        <h2 className="text-sm font-semibold tracking-tight">Activity</h2>
        <span className="hidden text-xs text-muted-foreground sm:inline">
          the AI working through tickets that need a reply
        </span>
        <div className="ml-auto flex items-center gap-3">
          {viewSwitch}
          <JobCountChips counts={jobs.counts} />
          <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={() => void onRun()} disabled={running}>
            {running ? <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> : <Play className="size-3.5" />}
            Run on backlog
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-4 pb-4 pt-1">
          {jobs.loading && jobs.jobs.length === 0 ? (
            <RowsSkeleton rows={8} />
          ) : jobs.error && jobs.jobs.length === 0 ? (
            <ErrorState
              title="Couldn't load the autopilot board"
              onRetry={() => jobs.refetch()}
              retrying={jobs.loading}
            />
          ) : sorted.length === 0 ? (
            <AutopilotEmpty />
          ) : (
            <ul className="space-y-3">
              {sorted.map((job, i) => (
                <li key={job.id}>
                  <JobRow job={job} index={i} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
