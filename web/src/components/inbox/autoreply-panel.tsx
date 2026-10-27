import { useEffect, useState } from "react";
import { ShieldAlert, Bot } from "lucide-react";
import { type AutoreplyDecision, fetchAutoreplyDecisions } from "@/lib/autoreply";
import { relativeTime } from "@/lib/tickets";
import { NerdStats } from "@/components/live/nerd-stats";
import { cn } from "@/lib/utils";

// The autoreply decision trail for a ticket — a nerd-mode panel above the thread explaining why the
// AI acted or held on each inbound. Stays quiet (renders nothing) when the endpoint is absent or
// there are no decisions, so it never clutters a normal conversation.
export function AutoreplyPanel({ ticketId, refreshKey }: { ticketId: string; refreshKey: number }) {
  const [rows, setRows] = useState<AutoreplyDecision[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setFailed(false);
    fetchAutoreplyDecisions(ticketId)
      .then((d) => live && setRows(d))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [ticketId, refreshKey]);

  // Endpoint not wired yet, or nothing to show → stay quiet rather than clutter.
  if (failed) return null;
  if (rows && rows.length === 0) return null;

  return (
    <div className="shrink-0 border-b bg-muted/20 px-4 py-2 sm:px-6">
      <div className="mx-auto max-w-3xl">
        <NerdStats title="autoreply decisions">
          {rows === null ? (
            <span className="text-muted-foreground">loading…</span>
          ) : (
            <div className="space-y-1.5">
              {rows.map((d, i) => (
                <DecisionRow key={d.id ?? i} d={d} />
              ))}
            </div>
          )}
        </NerdStats>
      </div>
    </div>
  );
}

/** Turn a raw decision row into a plain-language line + a tone. */
function describeDecision(d: AutoreplyDecision): { text: string; held: boolean } {
  const outcome = String(d.outcome ?? "").toLowerCase();
  if (outcome === "sent") return { text: "AI replied automatically", held: false };
  const reason = d.reason ?? "";
  if (reason.startsWith("guardrail")) {
    const topic = reason.split(":")[1];
    return { text: `AI held: guardrail${topic ? ` (${topic})` : ""}`, held: true };
  }
  if (reason.includes("agreement") || d.agreement != null) {
    const a = d.agreement ?? "?";
    const m = d.min_agreement ?? "?";
    return { text: `AI held: low corroboration (agreement ${a}/${m})`, held: true };
  }
  if (outcome === "draft") return { text: "AI prepared a draft for review", held: true };
  if (reason) return { text: `AI held: ${reason}`, held: true };
  return { text: outcome ? `AI: ${outcome}` : "AI decision recorded", held: true };
}

function DecisionRow({ d }: { d: AutoreplyDecision }) {
  const { text, held } = describeDecision(d);
  return (
    <div className="flex items-start justify-between gap-3">
      <span className={cn("flex items-center gap-1.5", held ? "text-warning" : "text-success")}>
        {held ? <ShieldAlert className="size-3 shrink-0" /> : <Bot className="size-3 shrink-0" />}
        <span className="text-foreground">{text}</span>
      </span>
      {d.created_at && (
        <span className="shrink-0 text-muted-foreground">{relativeTime(d.created_at)}</span>
      )}
    </div>
  );
}
