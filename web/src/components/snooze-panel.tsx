import { useState } from "react";
import { Loader2, X } from "lucide-react";
import { type Ticket, snoozeTicket } from "@/lib/tickets";

/** Park a ticket until later — it drops out of the open queues and auto-resurfaces at the wake
 *  time. Hosted inside the thread header's snooze popover: quiet menu rows, each naming its
 *  concrete wake time; unsnooze brings it back now. */
export function SnoozePanel({ ticket, onSnoozed }: { ticket: Ticket; onSnoozed?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const snoozed = ticket.snoozed_until && new Date(ticket.snoozed_until).getTime() > Date.now();

  async function apply(until: string | null) {
    setBusy(true);
    setError(false);
    try {
      await snoozeTicket(ticket.id, until);
      onSnoozed?.();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  // Preset wake times, computed client-side. "Tomorrow" / "Next week" land at 9am local.
  function at9am(daysAhead: number): Date {
    const d = new Date();
    d.setDate(d.getDate() + daysAhead);
    d.setHours(9, 0, 0, 0);
    return d;
  }
  const wakeLabel = (d: Date) =>
    d.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  const presets: { label: string; date: Date }[] = [
    { label: "1 hour", date: new Date(Date.now() + 60 * 60 * 1000) },
    { label: "Tomorrow", date: at9am(1) },
    { label: "Next week", date: at9am(7) },
  ];

  if (snoozed) {
    return (
      <div className="p-1">
        <p className="px-2 py-1.5 text-xs text-muted-foreground">
          Snoozed until{" "}
          <span className="font-medium text-foreground">
            {new Date(ticket.snoozed_until as string).toLocaleString([], {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </span>
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() => void apply(null)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-small transition-colors hover:bg-accent disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
          ) : (
            <X className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="flex-1">Unsnooze now</span>
        </button>
        {error && <p className="px-2 py-1 text-xs text-warning">Couldn't update — try again.</p>}
      </div>
    );
  }

  return (
    <div className="p-1">
      {presets.map((p) => (
        <button
          key={p.label}
          type="button"
          disabled={busy}
          onClick={() => void apply(p.date.toISOString())}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-small transition-colors hover:bg-accent disabled:opacity-50"
        >
          <span className="flex-1">{p.label}</span>
          <span className="shrink-0 text-micro tabular-nums text-muted-foreground">
            {wakeLabel(p.date)}
          </span>
        </button>
      ))}
      {error && <p className="px-2 py-1 text-xs text-warning">Couldn't snooze — try again.</p>}
    </div>
  );
}
