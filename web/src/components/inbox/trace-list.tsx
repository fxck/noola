import { Link } from "@tanstack/react-router";
import { traceOutcomeLabel, type TraceSummary, type TraceTone } from "@/lib/traces";
import { relativeTime } from "@/lib/tickets";
import { shortModel } from "@/lib/model-cost";
import { compactNum, fmtMs } from "@/components/live/nerd-stats";
import { cn } from "@/lib/utils";

// The AI trace table shared by the workspace page and a ticket's trace modal. A row opens the trace detail.

const TONE: Record<TraceTone, string> = { sent: "text-success", held: "text-warning", none: "text-muted-foreground" };

const TH = "px-3 py-2 text-left font-medium";
// The trace detail shows these too, so a phone drops them to keep the customer's text readable.
const WIDE = "hidden sm:table-cell";

export function TraceList({
  traces,
  showTicket = true,
  onOpen,
}: {
  traces: (TraceSummary & { ticketSubject?: string | null })[];
  showTicket?: boolean;
  onOpen: (id: string) => void;
}) {
  return (
    <table className="w-full text-small">
      <thead className="bg-muted/40 text-micro uppercase tracking-wide text-muted-foreground">
        <tr>
          <th className={TH}>When</th>
          <th className={TH}>Customer wrote</th>
          <th className={TH}>What Noola did</th>
          <th className={cn(TH, WIDE)}>Model</th>
          <th className={cn(TH, WIDE, "text-right")}>Tokens</th>
          <th className={cn(TH, WIDE, "text-right")}>Latency</th>
          {showTicket && <th className={TH}>Conversation</th>}
        </tr>
      </thead>
      <tbody>
        {traces.map((t) => {
          // A draft that found no sources has no gate decision, so the filter's label comes from the model.
          const { label, tone } =
            t.model === "grounding-guard"
              ? { label: "No sources found", tone: "held" as const }
              : traceOutcomeLabel(t.gateOutcome, t.gateReason);
          const firstLine = t.query.split("\n").find((l) => l.trim())?.trim() ?? "";
          return (
            <tr
              key={t.id}
              role="button"
              tabIndex={0}
              onClick={() => onOpen(t.id)}
              onKeyDown={(e) => {
                if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  onOpen(t.id);
                }
              }}
              className="cursor-pointer border-t outline-none transition-colors hover:bg-muted/50 focus-visible:relative focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <td className="whitespace-nowrap px-3 py-2 align-top text-xs tabular-nums text-muted-foreground" title={new Date(t.createdAt).toLocaleString()}>
                {relativeTime(t.createdAt)}
              </td>
              <td className="w-2/5 max-w-0 px-3 py-2 align-top">
                <div className="truncate text-foreground" title={t.query}>
                  {firstLine || <span className="text-muted-foreground">(empty)</span>}
                </div>
              </td>
              <td className={cn("whitespace-nowrap px-3 py-2 align-top", TONE[tone])}>
                {label}
                {t.sourceCount === 0 && t.model !== "grounding-guard" && <span className="text-muted-foreground"> · no sources</span>}
              </td>
              <td className={cn(WIDE, "max-w-40 truncate px-3 py-2 align-top font-mono text-xs text-muted-foreground")} title={t.model}>
                {shortModel(t.model)}{t.effort && ` · ${t.effort}`}
              </td>
              <td className={cn(WIDE, "whitespace-nowrap px-3 py-2 text-right align-top font-mono text-xs tabular-nums text-muted-foreground")}>
                {t.tokensIn == null && t.tokensOut == null ? "—" : `${compactNum(t.tokensIn ?? 0)} / ${compactNum(t.tokensOut ?? 0)}`}
              </td>
              <td className={cn(WIDE, "whitespace-nowrap px-3 py-2 text-right align-top font-mono text-xs tabular-nums text-muted-foreground")}>
                {fmtMs(t.latencyMs)}
              </td>
              {showTicket && (
                <td className="w-1/5 max-w-0 px-3 py-2 align-top">
                  {t.ticketId ? (
                    <Link
                      to="/tickets/$ticketId"
                      params={{ ticketId: t.ticketId }}
                      onClick={(e) => e.stopPropagation()}
                      className="block truncate text-primary hover:underline"
                      title={t.ticketSubject ?? undefined}
                    >
                      {t.ticketSubject || "Open conversation"}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">No conversation</span>
                  )}
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
