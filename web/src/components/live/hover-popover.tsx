import { useCallback, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/**
 * A dependency-free hover/focus popover. The trigger stays inline; the content
 * floats in a portal (position: fixed) so it never clips inside a scroll
 * container. Opens on hover OR keyboard focus, stays open while the pointer is
 * over the trigger or the popover, and flips below the trigger when it's near
 * the top of the viewport. Motion respects prefers-reduced-motion.
 *
 * This is the canonical way to reveal nerd-stat detail — a subtle inline hint,
 * the full breakdown on hover in a beautiful pop, never a block shoved into the
 * middle of the content.
 */
export function HoverPopover({
  children,
  content,
  align = "start",
  triggerClassName,
}: {
  children: ReactNode;
  content: ReactNode;
  align?: "start" | "end";
  triggerClassName?: string;
}) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const closeTimer = useRef<number | null>(null);
  const [box, setBox] = useState<{ top: number; left: number; place: "top" | "bottom" } | null>(null);

  const open = useCallback(() => {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const place: "top" | "bottom" = r.top < 240 ? "bottom" : "top";
    setBox({
      top: place === "top" ? r.top : r.bottom,
      left: align === "end" ? r.right : r.left,
      place,
    });
  }, [align]);

  const scheduleClose = useCallback(() => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setBox(null), 120);
  }, []);

  const reduce =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  if (!content) return <>{children}</>;

  return (
    <>
      <span
        ref={triggerRef}
        tabIndex={0}
        onMouseEnter={open}
        onMouseLeave={scheduleClose}
        onFocus={open}
        onBlur={scheduleClose}
        className={cn(
          "cursor-help rounded outline-none ring-offset-1 focus-visible:ring-1 focus-visible:ring-ring",
          triggerClassName,
        )}
      >
        {children}
      </span>
      {box &&
        createPortal(
          <div
            onMouseEnter={open}
            onMouseLeave={scheduleClose}
            role="tooltip"
            style={{
              position: "fixed",
              top: box.top,
              left: box.left,
              transform: `translate(${align === "end" ? "-100%" : "0"}, ${
                box.place === "top" ? "calc(-100% - 8px)" : "8px"
              })`,
            }}
            className={cn(
              "z-[60] w-max max-w-[min(21rem,92vw)]",
              // Scale from the edge nearest the trigger (origin-aware popover).
              box.place === "top" ? "origin-bottom" : "origin-top",
              !reduce && "motion-safe:animate-[nerd-in_.14s_var(--ease-out-strong)]",
            )}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
