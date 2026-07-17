import { useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, Minus, Play, X } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Run dock (ported from weft's LiveDock) ────────────────────────────────────
// A corner-pinned picture-in-picture surface over the Studio canvas. While a browser flow runs it
// streams the container's Chromium LIVE (~1.4fps JPEG frames off the run channel); when the run
// ends it holds the last frame with a DONE badge. A compact per-node log rides under the picture —
// the same events that light the canvas, readable as a feed. Drag the header to snap to any of the
// four corners; expand for a theater view; minimize to a chip. Floats without consuming canvas
// width, so you keep editing while you watch.

export interface RunLogEntry {
  t: number;
  nodeId: string;
  label: string;
  phase: "start" | "end" | "step";
  ok?: boolean;
  detail?: string;
}

type Corner = "tl" | "tr" | "bl" | "br";
const CORNER_CLASS: Record<Corner, string> = {
  tl: "left-3 top-3",
  tr: "right-3 top-3",
  bl: "bottom-3 left-3",
  br: "bottom-3 right-3",
};

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function RunDock({
  open,
  running,
  frame,
  log,
  replayUrl,
  replayLabel,
  onClose,
}: {
  open: boolean;
  running: boolean;
  /** Latest live frame as a data URL; held after the run ends (poster behavior). */
  frame: string | null;
  log: RunLogEntry[];
  /** A finished run's recorded .webm (presigned): swaps the still frame for a scrubbable player. */
  replayUrl?: string | null;
  /** Optional caption for the replay (e.g. the run's time) shown in the header. */
  replayLabel?: string | null;
  onClose: () => void;
}) {
  const [minimized, setMinimized] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [dock, setDock] = useState<Corner>("bl");

  // Hold the last live frame as the video poster so the LIVE→REPLAY swap never flashes blank.
  const posterRef = useRef<string | null>(null);
  if (frame) posterRef.current = frame;

  const mode: "live" | "replay" | "done" | "idle" = running
    ? "live"
    : replayUrl
      ? "replay"
      : frame
        ? "done"
        : "idle";

  // Live elapsed timer (client-side; freezes when the run ends).
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(0);
  useEffect(() => {
    if (!running) return;
    startRef.current = Date.now();
    setElapsed(0);
    const t = setInterval(() => setElapsed(Date.now() - startRef.current), 500);
    return () => clearInterval(t);
  }, [running]);

  // Log feed auto-follows its tail.
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length]);

  // Drag the header to move; snap to the nearest corner on release.
  const dragActive = useRef(false);
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null);
  const onHeaderDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return; // let header buttons click
    dragActive.current = true;
    const sx = e.clientX;
    const sy = e.clientY;
    const move = (ev: PointerEvent) => {
      if (dragActive.current) setOffset({ x: ev.clientX - sx, y: ev.clientY - sy });
    };
    const up = (ev: PointerEvent) => {
      dragActive.current = false;
      setOffset(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const corner = ((ev.clientY < window.innerHeight / 2 ? "t" : "b") +
        (ev.clientX < window.innerWidth / 2 ? "l" : "r")) as Corner;
      setDock(corner);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Esc collapses the theater.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setExpanded(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  if (!open) return null;

  const runningEntry = [...log].reverse().find((l) => l.phase !== "end");
  const title =
    mode === "live"
      ? (runningEntry?.label ?? "Starting…")
      : mode === "replay"
        ? (replayLabel ?? "Replay")
        : mode === "done"
          ? "Finished"
          : "Idle";

  // Minimized → a small draggable chip.
  if (minimized) {
    return (
      <button
        type="button"
        className={cn(
          "absolute z-30 flex items-center gap-1.5 rounded-full border bg-popover px-2.5 py-1 text-micro font-medium shadow-md",
          CORNER_CLASS[dock],
        )}
        style={offset ? { transform: `translate(${offset.x}px, ${offset.y}px)` } : undefined}
        onPointerDown={onHeaderDown}
        onClick={() => setMinimized(false)}
        title="Show preview"
      >
        <span className={cn("size-1.5 rounded-full", mode === "live" ? "animate-pulse bg-red-500" : "bg-emerald-500")} />
        {mode === "live" ? title : "Preview"}
        {mode === "live" && <span className="tabular-nums text-muted-foreground">{fmtElapsed(elapsed)}</span>}
      </button>
    );
  }

  const card = (
    <div
      className={cn(
        "z-30 flex flex-col overflow-hidden rounded-xl border bg-popover shadow-xl",
        expanded ? "w-[min(72rem,90vw)]" : cn("absolute w-80", CORNER_CLASS[dock]),
      )}
      style={!expanded && offset ? { transform: `translate(${offset.x}px, ${offset.y}px)` } : undefined}
    >
      <div
        className="flex cursor-grab items-center gap-2 border-b bg-muted/40 px-2.5 py-1.5 active:cursor-grabbing"
        onPointerDown={expanded ? undefined : onHeaderDown}
      >
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide",
            mode === "live" ? "bg-red-500/10 text-red-500" : "bg-muted text-muted-foreground",
          )}
        >
          <span className={cn("size-1.5 rounded-full", mode === "live" ? "animate-pulse bg-red-500" : "bg-emerald-500")} />
          {mode === "live" ? "LIVE" : mode === "replay" ? "REPLAY" : mode === "done" ? "DONE" : "PREVIEW"}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{title}</span>
        {mode === "live" && <span className="text-micro tabular-nums text-muted-foreground">{fmtElapsed(elapsed)}</span>}
        <span className="flex shrink-0 items-center">
          <button type="button" className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground" title="Minimize" onClick={() => setMinimized(true)}>
            <Minus className="size-3.5" />
          </button>
          <button type="button" className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground" title={expanded ? "Collapse" : "Expand"} onClick={() => setExpanded((v) => !v)}>
            {expanded ? <Minimize2 className="size-3" /> : <Maximize2 className="size-3" />}
          </button>
          <button type="button" className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground" title="Close" onClick={onClose}>
            <X className="size-3.5" />
          </button>
        </span>
      </div>

      <div className="grid aspect-video place-items-center bg-black/90">
        {mode === "replay" && replayUrl ? (
          <video
            key={replayUrl}
            className="size-full object-contain"
            src={replayUrl}
            poster={posterRef.current ?? undefined}
            controls
            autoPlay
            preload="metadata"
          />
        ) : frame ? (
          <img className="size-full object-contain" src={frame} alt="Live browser preview" />
        ) : mode === "live" ? (
          <div className="flex flex-col items-center gap-2 text-xs text-white/60">
            <span className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white/80" />
            Waiting for the first frame…
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 text-xs text-white/60">
            <Play className="size-5" />
            Run the flow to watch it happen
          </div>
        )}
      </div>

      {log.length > 0 && (
        <div ref={logRef} className={cn("overflow-y-auto border-t px-2.5 py-1.5", expanded ? "max-h-48" : "max-h-24")}>
          {log.map((l, i) => (
            <div key={i} className="flex items-baseline gap-1.5 py-px text-micro leading-snug">
              <span
                className={cn(
                  "size-1.5 shrink-0 translate-y-[-1px] rounded-full",
                  l.phase === "end" ? (l.ok ? "bg-emerald-500" : "bg-red-500") : "bg-amber-500",
                )}
              />
              <span className="shrink-0 font-medium">{l.label}</span>
              {l.detail && <span className="min-w-0 flex-1 truncate text-muted-foreground">{l.detail}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  if (expanded) {
    return (
      <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-6" onClick={() => setExpanded(false)}>
        <div onClick={(e) => e.stopPropagation()}>{card}</div>
      </div>
    );
  }
  return card;
}
