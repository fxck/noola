import { Activity, Users } from "lucide-react";
import { useRealtime } from "@/lib/realtime-context";
import { useNerdMode } from "@/lib/nerd-mode";
import { fmtMs } from "@/components/live/nerd-stats";
import { BUILD_ID } from "@/lib/build-info";
import { cn } from "@/lib/utils";

const Dot = () => (
  <span aria-hidden className="text-muted-foreground/40">
    ·
  </span>
);

/**
 * The nerd-mode HUD — a quiet mono readout of the live connection: round-trip
 * latency, events/min, who's online, and the build marker. Lives in the nav
 * rail footer, so it's a compact wrap-safe block (not the old top-bar strip);
 * only rendered when nerd mode is on.
 */
export function RtHud({ className }: { className?: string }) {
  const { nerd } = useNerdMode();
  const { latencyMs, eventsPerMin, presence, status } = useRealtime();
  if (!nerd) return null;

  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-micro leading-tight text-muted-foreground",
        className,
      )}
      title="Realtime HUD — round-trip latency · live events/min · online · build"
    >
      <Activity className={cn("size-3 shrink-0", status === "live" ? "text-success" : "text-muted-foreground")} />
      <span className="tabular-nums">{fmtMs(latencyMs)}</span>
      <Dot />
      <span className="tabular-nums">{eventsPerMin}/min</span>
      <Dot />
      <span className="inline-flex items-center gap-1 tabular-nums" title="online now">
        <Users className="size-3" />
        {presence.length}
      </span>
      <Dot />
      <span className="truncate text-muted-foreground/70" title="build">
        {BUILD_ID}
      </span>
    </div>
  );
}
