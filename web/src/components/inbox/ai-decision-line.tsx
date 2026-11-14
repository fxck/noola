import { useEffect, useState } from "react";
import { ShieldAlert, Bot } from "lucide-react";
import { type AutoreplyDecision, fetchAutoreplyDecisions } from "@/lib/autoreply";
import { TraceDialog } from "@/components/inbox/trace-dialog";
import { useAuth } from "@/auth/auth";
import { cn } from "@/lib/utils";

// How the AI handled each inbound message, as a quiet line in the thread under the message it decided on.

/** The ticket's autoreply decisions, refetched on `refreshKey`. Recording a decision emits a ticket event, which bumps it. */
export function useAutoreplyDecisions(ticketId: string, refreshKey: number): AutoreplyDecision[] {
  // Keyed by ticket, so a switch never shows the previous ticket's decisions while the new ones load.
  const [loaded, setLoaded] = useState<{ ticketId: string; rows: AutoreplyDecision[] } | null>(null);

  useEffect(() => {
    let live = true;
    fetchAutoreplyDecisions(ticketId)
      .then((rows) => live && setLoaded({ ticketId, rows }))
      .catch(() => live && setLoaded((prev) => (prev?.ticketId === ticketId ? prev : { ticketId, rows: [] })));
    return () => {
      live = false;
    };
  }, [ticketId, refreshKey]);

  return loaded?.ticketId === ticketId ? loaded.rows : [];
}

/** Turn a raw decision row into a plain-language line + a tone. */
function describeDecision(d: AutoreplyDecision): { text: string; held: boolean } {
  const outcome = String(d.outcome ?? "").toLowerCase();
  const reason = d.reason ?? "";
  if (reason === "ondemand_sent") return { text: "AI answered an /ask in the channel", held: false };
  if (outcome === "auto_sent" || outcome === "sent") return { text: "AI replied automatically", held: false };
  if (reason === "no_reply_needed") return { text: "AI decided no reply is needed", held: false };
  if (reason === "no_reply_suggested") return { text: "AI suggests no reply is needed", held: true };
  if (reason === "note_only") return { text: "AI left a note for the team instead of replying", held: true };
  if (reason === "handoff") return { text: "AI handed the conversation to a teammate", held: true };
  if (reason === "handoff_requested") return { text: "AI handed the conversation to a teammate: the customer asked for a person", held: true };
  if (reason === "malformed_output") return { text: "AI held: its answer was malformed", held: true };
  if (reason.startsWith("guardrail")) {
    const topic = reason.split(":")[1];
    return { text: `AI held: guardrail${topic ? ` (${topic})` : ""}`, held: true };
  }
  if (reason === "weak_retrieval" || reason.includes("agreement")) {
    const a = d.agreement ?? "?";
    return { text: `AI held: low corroboration (agreement ${a}${d.min_agreement != null ? `/${d.min_agreement}` : ""})`, held: true };
  }
  if (reason === "suggest_only" || outcome === "draft") return { text: "AI prepared a draft for review", held: true };
  if (reason === "low_confidence") return { text: "AI held: low confidence", held: true };
  if (reason === "thread_cap") return { text: "AI held: this conversation reached its auto-reply limit", held: true };
  if (reason === "rate_limited" || reason === "ondemand_rate_limited") return { text: "AI held: the hourly auto-reply limit was reached", held: true };
  if (reason === "kill") return { text: "AI held: the AI is switched off", held: true };
  if (reason === "channel_skipped") return { text: "AI skipped this message: AI replies are off on this channel", held: false };
  if (reason === "claimed_elsewhere") return { text: "AI stood down: another answer already covered this message", held: false };
  if (reason) return { text: `AI held: ${reason}`, held: true };
  return { text: outcome ? `AI: ${outcome}` : "AI decision recorded", held: true };
}

/** One autoreply decision in the thread. `attached` pulls it up under the inbound message it is about. */
export function AiDecisionLine({ decision, attached }: { decision: AutoreplyDecision; attached: boolean }) {
  const { user } = useAuth();
  const [traceOpen, setTraceOpen] = useState(false);
  const { text, held } = describeDecision(decision);
  const traceId = decision.trace_id ?? null;
  const canViewTrace = !!traceId && (user?.role === "admin" || user?.role === "owner");

  return (
    <li className={cn("flex items-start gap-1.5 pl-10 text-micro text-muted-foreground", attached && "-mt-2")}>
      {held ? (
        <ShieldAlert className="mt-px size-3 shrink-0 text-warning" aria-hidden />
      ) : (
        <Bot className="mt-px size-3 shrink-0 text-muted-foreground/70" aria-hidden />
      )}
      <span className="min-w-0">
        <span title={decision.created_at ? new Date(decision.created_at).toLocaleString() : undefined}>{text}</span>
        {canViewTrace && (
          <>
            <span aria-hidden className="text-muted-foreground/40"> · </span>
            <button type="button" onClick={() => setTraceOpen(true)} className="text-primary hover:underline">
              View trace
            </button>
          </>
        )}
      </span>
      {traceOpen && traceId && <TraceDialog traceId={traceId} onClose={() => setTraceOpen(false)} />}
    </li>
  );
}
