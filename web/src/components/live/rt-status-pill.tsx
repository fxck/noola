import { useEffect, useState } from "react";
import { useRealtime } from "@/lib/realtime-context";
import { cn } from "@/lib/utils";

// How long a first-connect may sit "connecting" before we treat it as a fault and
// offer a manual retry. A wedged edge socket (a documented failure mode) otherwise
// sits pending forever; a calm neutral pulse that escalates to click-to-reconnect
// is the honest signal.
const STALL_MS = 10_000;

type Display = "connecting" | "live" | "down";

// The Noola Signal, three states on one ripple vocabulary (see index.css):
//  • live       — steady amber core + a slow breathing ring ("the noola is lit").
//  • connecting — amber core + an outward sonar ping ("searching / acquiring").
//  • down       — a hollow graphite ring, no light, becomes a click-to-reconnect.
// Amber is the reserved signal hue here on purpose: this IS the namesake status,
// not decoration. It's ambient (never a per-action animation), so motion is earned.
const META: Record<Display, { core: string; ring: "noola-breathe" | "noola-ping" | null; label: string }> = {
  connecting: { core: "bg-primary", ring: "noola-ping", label: "Connecting…" },
  live: { core: "bg-primary", ring: "noola-breathe", label: "Live" },
  down: { core: "border border-muted-foreground", ring: null, label: "Offline" },
};

/**
 * Always-on realtime health signal in the top bar — the Noola Signal. A lit amber
 * noola (breathing) when the edge socket is joined; an outward sonar ping while
 * connecting; and — on a genuine drop or a connect that stalls past {@link STALL_MS}
 * — a hollow graphite ring that becomes a click-to-reconnect. App-wide; every screen.
 */
export function RtStatusPill({ className }: { className?: string }) {
  const { status, reconnect } = useRealtime();
  const [stalled, setStalled] = useState(false);

  // Escalate a too-long "connecting" to the offline/retry affordance.
  useEffect(() => {
    if (status !== "connecting") {
      setStalled(false);
      return;
    }
    const t = setTimeout(() => setStalled(true), STALL_MS);
    return () => clearTimeout(t);
  }, [status]);

  const display: Display = status === "connecting" && stalled ? "down" : status;
  const m = META[display];

  const dot = (
    <span className="relative flex size-2 items-center justify-center">
      {m.ring && (
        <span className={cn("absolute inline-flex size-2 rounded-full bg-primary/70", m.ring)} />
      )}
      <span className={cn("relative inline-flex size-2 rounded-full", m.core)} />
    </span>
  );

  const base = "hidden items-center gap-1.5 px-1.5 text-xs text-muted-foreground sm:flex";

  if (display === "down") {
    return (
      <button
        type="button"
        onClick={reconnect}
        title="Realtime offline — click to reconnect"
        className={cn(
          base,
          "rounded-md transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
      >
        {dot}
        <span className="hidden md:inline">Reconnect</span>
      </button>
    );
  }

  return (
    <span className={cn(base, className)} title={`Realtime: ${m.label}`}>
      {dot}
      <span className="hidden md:inline">{m.label}</span>
    </span>
  );
}
