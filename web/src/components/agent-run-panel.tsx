import { useState } from "react";
import { Loader2, Play, CheckCircle2, XCircle, FlaskConical, Zap } from "lucide-react";
import { type AgentRunResult, runTicketAgent } from "@/lib/agent";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** "Resolve this for me" — runs the autonomous multi-step agent loop against the ticket. Defaults
 *  to a SAFE dry run (tools report what they'd do); a Live toggle actually executes. Shows the
 *  step-by-step trace so the agent's reasoning + actions are auditable. */
export function AgentRunPanel({ ticketId, onLiveRun }: { ticketId: string; onLiveRun?: () => void }) {
  const [live, setLive] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AgentRunResult | null>(null);
  const [error, setError] = useState(false);
  const [model, setModel] = useState("");

  async function run() {
    setRunning(true);
    setError(false);
    try {
      const r = await runTicketAgent(ticketId, { live, model: model.trim() || undefined });
      setResult(r);
      if (live) onLiveRun?.();
    } catch {
      setError(true);
    } finally {
      setRunning(false);
    }
  }

  // Hosted inside the thread overflow popover (it supplies the title row).
  return (
    <section>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {/* dry-run / live toggle */}
        <div className="inline-flex items-center rounded-lg border bg-muted/40 p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setLive(false)}
            className={cn("inline-flex items-center gap-1 rounded-md px-2 py-1 transition-colors",
              !live ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
          >
            <FlaskConical className="size-3" /> Dry run
          </button>
          <button
            type="button"
            onClick={() => setLive(true)}
            className={cn("inline-flex items-center gap-1 rounded-md px-2 py-1 transition-colors",
              live ? "bg-background font-medium text-warning shadow-sm" : "text-muted-foreground hover:text-foreground")}
          >
            <Zap className="size-3" /> Live
          </button>
        </div>
      </div>

      <p className="mt-1.5 text-xs text-muted-foreground">
        {live
          ? "Live: the agent will take real actions on this ticket (reply, set status, assign…)."
          : "Dry run: the agent plans and reports what it would do — nothing is changed."}
      </p>

      <div className="mt-3">
        <Input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="Model (optional — workspace default)"
          className="h-8 text-xs"
          aria-label="Model override"
        />
      </div>

      <Button size="sm" className="mt-2" onClick={() => void run()} disabled={running}>
        {running ? <><Loader2 className="animate-spin motion-reduce:animate-none" /> Working…</> : <><Play /> Run agent</>}
      </Button>

      {error && <p className="mt-2 text-xs text-warning">Couldn't run the agent — please try again.</p>}

      {result && (
        <div className="mt-3 space-y-2">
          {result.steps.length === 0 && result.actions.length === 0 ? (
            <p className="text-xs text-muted-foreground">The agent decided no action was needed.</p>
          ) : (
            <>
              {result.actions.length > 0 && (
                <ol className="space-y-1">
                  {result.actions.map((a, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-xs">
                      {a.ok ? (
                        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
                      ) : (
                        <XCircle className="mt-0.5 size-3.5 shrink-0 text-warning" />
                      )}
                      <span>
                        <code className="rounded bg-muted/60 px-1 font-mono text-micro">{a.type}</code>{" "}
                        <span className="text-muted-foreground">{a.detail}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              )}
              {result.steps.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Full trace ({result.steps.length} steps)</summary>
                  <ol className="mt-1 space-y-0.5 border-l pl-3 text-muted-foreground">
                    {result.steps.map((s, i) => (
                      <li key={i} className="font-mono text-micro leading-relaxed">{s}</li>
                    ))}
                  </ol>
                </details>
              )}
              <p className="text-micro text-muted-foreground">
                {result.live ? "Ran live — actions above were applied." : "Dry run — nothing was changed."}
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
