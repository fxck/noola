import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, Monitor, Smartphone } from "lucide-react";
import { TAB_BASE, TAB_OFF, TAB_ON } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";

const DEVICE_WIDTH = { desktop: 600, mobile: 375 } as const;
const SCROLLER_PADDING = 48; // px-6 both sides

/**
 * Server-rendered email preview — the sandboxed iframe with a desktop/mobile
 * width toggle, shared by the template designer and broadcast compose. The
 * server owns email HTML (the client never approximates it); this component
 * only frames what the render endpoint sent back. Its inner scroller owns any
 * overflow, so a 600px frame in a narrow pane scrolls HERE, never at page level.
 */
export function EmailPreview({
  html,
  refreshing = false,
  failed = false,
  actions,
  frameHeight = 640,
  className,
}: {
  /** Full rendered document for the iframe; null = nothing rendered yet. */
  html: string | null;
  /** A newer render is in flight — the stale frame dims instead of flashing empty. */
  refreshing?: boolean;
  /** The last render attempt failed (kept quiet while a stale frame still shows). */
  failed?: boolean;
  /** Extra header controls (e.g. "Send test to me"), right of the width toggle. */
  actions?: ReactNode;
  frameHeight?: number;
  className?: string;
}) {
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  // Fit-to-width: measure the scroller and scale the true-width frame DOWN to fit the pane, so the
  // desktop (600px) preview never overflows into a horizontal scrollbar / clipped frame in a narrow
  // pane. Never upscale (scale ≤ 1) — a small frame stays its real size.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(0);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setAvail(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const deviceWidth = DEVICE_WIDTH[device];
  const scale = avail > 0 ? Math.min(1, (avail - SCROLLER_PADDING) / deviceWidth) : 1;

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex h-12 shrink-0 items-center gap-2 px-4">
        <span className="text-xs font-medium text-muted-foreground">Preview</span>
        {refreshing && (
          <Loader2 className="size-3 animate-spin text-muted-foreground/60 motion-reduce:animate-none" />
        )}
        {failed && html != null && (
          <span className="text-xs text-muted-foreground">Couldn't refresh the preview.</span>
        )}
        <div
          role="radiogroup"
          aria-label="Preview width"
          className="ml-auto inline-flex items-center gap-0.5 rounded-lg border bg-muted/60 p-0.5"
        >
          {(
            [
              { key: "desktop", label: "Desktop", Icon: Monitor },
              { key: "mobile", label: "Mobile", Icon: Smartphone },
            ] as const
          ).map(({ key, label, Icon }) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={device === key}
              onClick={() => setDevice(key)}
              className={cn(TAB_BASE, device === key ? TAB_ON : TAB_OFF)}
            >
              <Icon className="size-3.5" /> {label}
            </button>
          ))}
        </div>
        {actions}
      </div>

      {/* Vertical-only scroller — the frame is scaled to fit the pane width (below), so there is
          never horizontal overflow. */}
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="mx-auto w-fit px-6 pb-8 pt-1">
          {html == null && failed ? (
            <div
              className="grid w-[min(600px,80vw)] place-items-center rounded-xl border border-dashed"
              style={{ height: frameHeight }}
            >
              <p className="max-w-xs px-6 text-center text-sm text-muted-foreground">
                The preview couldn't be rendered. Adjust the content or check your connection to
                try again.
              </p>
            </div>
          ) : html == null ? (
            <div
              className="w-[min(600px,80vw)] animate-pulse rounded-xl bg-muted motion-reduce:animate-none"
              style={{ height: frameHeight }}
            />
          ) : (
            // Outer box reserves the SCALED footprint (crisp border + rounded corners); the inner box
            // is the true device size, visually scaled from its top-left to fit.
            <div
              className="overflow-hidden rounded-xl border border-border/80 shadow-sm transition-[width,height] duration-200 ease-[var(--ease-out-strong)] motion-reduce:transition-none"
              style={{ width: deviceWidth * scale, height: frameHeight * scale }}
            >
              <div
                style={{
                  width: deviceWidth,
                  height: frameHeight,
                  transform: `scale(${scale})`,
                  transformOrigin: "top left",
                }}
              >
                <iframe
                  title="Email preview"
                  sandbox=""
                  srcDoc={html}
                  style={{ width: deviceWidth, height: frameHeight }}
                  className={cn(
                    "block bg-white transition-opacity duration-200 ease-[var(--ease-out-strong)] motion-reduce:transition-none",
                    refreshing ? "opacity-60" : "opacity-100",
                  )}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
