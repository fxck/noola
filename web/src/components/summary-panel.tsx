import { useState } from "react";
import { Loader2, Sparkles, Copy, Check } from "lucide-react";
import { summarizeTicket, type TicketSummary } from "@/lib/summary";
import { Button } from "@/components/ui/button";

/** One-click thread summary for handoff / triage — condenses the conversation into an agent-facing
 *  wrap-up (issue · what's been tried · status · next step) via the workspace model, with an
 *  extractive fallback on the rule baseline. */
export function SummaryPanel({ ticketId }: { ticketId: string }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TicketSummary | null>(null);
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState(false);

  async function run() {
    setLoading(true);
    setError(false);
    try {
      setResult(await summarizeTicket(ticketId));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  async function copy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.summary);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable — no-op */ }
  }

  // Hosted inside the thread overflow popover, which supplies the title row —
  // no chrome of its own (STRUCTURE.md §6).
  return (
    <section>
      {result && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => void copy()}
            className="inline-flex items-center gap-1 text-micro text-muted-foreground hover:text-foreground"
            aria-label="Copy summary"
          >
            {copied ? <><Check className="size-3" /> Copied</> : <><Copy className="size-3" /> Copy</>}
          </button>
        </div>
      )}

      {result ? (
        <>
          <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-foreground">{result.summary}</p>
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => void run()} disabled={loading}>
              {loading ? <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> : <Sparkles className="size-3.5" />} Regenerate
            </Button>
            <span className="text-micro text-muted-foreground">{result.model === "extractive" ? "rule-based" : result.model}</span>
          </div>
        </>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">Condense this thread for a teammate picking it up.</p>
          <Button size="sm" className="mt-2 gap-1.5" onClick={() => void run()} disabled={loading}>
            {loading ? <><Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> Summarizing…</> : <><Sparkles className="size-3.5" /> Summarize thread</>}
          </Button>
        </>
      )}

      {error && <p className="mt-2 text-xs text-warning">Couldn't summarize — please try again.</p>}
    </section>
  );
}
