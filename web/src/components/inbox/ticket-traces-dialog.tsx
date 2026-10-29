import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Sparkles, X } from "lucide-react";
import { fetchTicketTraces, type TraceSummary } from "@/lib/traces";
import { TraceList } from "@/components/inbox/trace-list";
import { TraceDialog } from "@/components/inbox/trace-dialog";

// Every AI draft on one ticket, for an admin. A row opens the trace detail above this modal.
export function TicketTracesDialog({ ticketId, onClose }: { ticketId: string; onClose: () => void }) {
  const [traces, setTraces] = useState<TraceSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [openTrace, setOpenTrace] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setTraces(null);
    setFailed(false);
    fetchTicketTraces(ticketId)
      .then((t) => live && setTraces(t))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [ticketId]);

  // The trace detail handles Escape itself while it is open.
  useEffect(() => {
    if (openTrace) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, openTrace]);

  // The trace detail sits beside the overlay, so a click on it never bubbles to the overlay's close.
  return createPortal(
    <>
    <div
      className="motion-overlay fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="AI traces"
      onClick={onClose}
    >
      <div
        className="motion-pop my-auto flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border bg-card shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-2">
            <Sparkles className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-foreground">AI traces</h2>
              <p className="text-micro text-muted-foreground">Every AI draft on this conversation, including drafts that sent nothing.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {failed ? (
            <p className="px-5 py-8 text-center text-sm text-muted-foreground">Couldn't load the traces.</p>
          ) : traces === null ? (
            <div className="px-5 py-8">
              <div className="mx-auto h-4 w-40 rounded bg-muted/60 motion-safe:animate-pulse" />
            </div>
          ) : traces.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-muted-foreground">The AI has not drafted anything on this conversation.</p>
          ) : (
            <TraceList traces={traces} showTicket={false} onOpen={setOpenTrace} />
          )}
        </div>
      </div>
    </div>
    {openTrace && <TraceDialog traceId={openTrace} onClose={() => setOpenTrace(null)} />}
    </>,
    document.body,
  );
}
