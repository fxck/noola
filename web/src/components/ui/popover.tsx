import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/** Gap between the trigger and the panel, on whichever side the panel lands. */
const GAP = 6;

/**
 * A small portal-based popover anchored to its trigger. Closes on outside-click
 * and Escape; repositions on scroll/resize. Portaled to <body> so a sticky/overflow
 * toolbar never clips it. Content animates in via the shared `.motion-pop` (origin-aware,
 * reduced-motion respected). This is the primitive behind Combobox / MultiSelect / faceted
 * filters — the app's real replacement for native <select> menus.
 *
 * Opens below the trigger, flipping above it when the panel wouldn't fit — a trigger in a
 * bottom toolbar (the tables' rows-per-page select) otherwise dropped its menu off-screen.
 */
export function Popover({
  open,
  onOpenChange,
  trigger,
  children,
  align = "start",
  width,
  triggerClassName,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactNode;
  children: ReactNode;
  align?: "start" | "end";
  /** fixed panel width; defaults to matching the trigger's width */
  width?: number;
  triggerClassName?: string;
  className?: string;
}) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [flip, setFlip] = useState(false);

  useLayoutEffect(() => {
    if (!open) {
      setFlip(false); // next open re-measures from scratch rather than inheriting a stale side
      return;
    }
    const place = () => setRect(triggerRef.current?.getBoundingClientRect() ?? null);
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  // Side selection runs a beat after placement: the panel has to be mounted before its height is
  // knowable, so the first pass renders below and this pass — still pre-paint, so no visible
  // flicker — flips it above when it overflows the viewport and there's more room up there. Keyed
  // on `rect` so scroll/resize (which mint a fresh DOMRect) re-decide as the trigger moves.
  useLayoutEffect(() => {
    if (!open || !rect) return;
    const height = contentRef.current?.offsetHeight ?? 0;
    if (!height) return;
    const below = window.innerHeight - rect.bottom - GAP;
    const above = rect.top - GAP;
    setFlip(height > below && above > below);
  }, [open, rect]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || contentRef.current?.contains(t)) return;
      onOpenChange(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onOpenChange]);

  return (
    <>
      <span ref={triggerRef} className={cn("inline-flex", triggerClassName)}>
        {trigger}
      </span>
      {open &&
        rect &&
        createPortal(
          <div
            ref={contentRef}
            role="dialog"
            style={{
              position: "fixed",
              ...(flip
                ? { bottom: window.innerHeight - rect.top + GAP }
                : { top: rect.bottom + GAP }),
              ...(align === "end"
                ? { right: Math.max(8, window.innerWidth - rect.right) }
                : { left: Math.max(8, rect.left) }),
              // A provided `width` is a HARD width so panel content (e.g. an AI summary) WRAPS
              // instead of stretching the popover toward the viewport edge; without one, the panel
              // grows from the trigger's width to fit its content. Both stay capped to the viewport.
              ...(width != null ? { width } : { minWidth: rect.width }),
              maxWidth: `calc(100vw - 16px)`,
            }}
            className={cn(
              "motion-pop z-50 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg",
              flip ? "origin-bottom" : "origin-top", // the pop scales out of the edge it's anchored to
              className,
            )}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}
