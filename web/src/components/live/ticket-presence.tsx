import { Eye } from "lucide-react";
import { useRealtime } from "@/lib/realtime-context";
import { cn } from "@/lib/utils";

/** Three subtly bouncing dots — the "typing…" affordance. Respects reduced-motion. */
function TypingDots({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-end gap-0.5", className)} aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="typing-dot inline-block size-1 rounded-full bg-current"
          style={{ animationDelay: `${i * 160}ms` }}
        />
      ))}
    </span>
  );
}

/**
 * Per-ticket presence for the thread header: how many other agents are viewing
 * this ticket, and who (if anyone) is typing a reply on it right now. Reads the
 * app-wide presence and filters to this ticket id. Silent when it's just you.
 */
export function TicketPresence({ ticketId }: { ticketId: string }) {
  const { others } = useRealtime();
  const viewers = others.filter((o) => o.viewing === ticketId);
  const typers = others.filter((o) => o.typing === ticketId);
  if (viewers.length === 0 && typers.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {viewers.length > 0 && (
        <span
          className="flex items-center gap-1"
          title={viewers.map((v) => v.name).join(", ")}
        >
          <Eye className="size-3.5" />
          {viewers.length} viewing
        </span>
      )}
      {typers.length > 0 && (
        <span className="flex items-center gap-1.5 text-primary">
          <TypingDots />
          {typers.length === 1 ? `${typers[0].name} is typing…` : `${typers.length} people typing…`}
        </span>
      )}
    </div>
  );
}
