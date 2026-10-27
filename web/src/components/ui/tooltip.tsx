import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

type Side = "top" | "bottom" | "left" | "right";

/**
 * The shared hover/focus tooltip — the app's replacement for native `title=` (which is
 * unstyled, invisible on touch, and screen-reader-inconsistent). Portaled to <body> so a
 * sticky/overflow toolbar never clips it; opens after `delay` to avoid accidental flashes;
 * fades + scales in on the app's ease-out curve (transform+opacity only, scale from 0.96 not
 * 0 — never from nothing). pointer-events:none so it never eats a click. Accessible:
 * role="tooltip" + aria-describedby wired to the trigger while open.
 */
export function Tooltip({
  content,
  children,
  side = "top",
  delay = 350,
  className,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: Side;
  delay?: number;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();

  const openLater = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setRect(ref.current?.getBoundingClientRect() ?? null);
      setOpen(true);
    }, delay);
  };
  const closeNow = () => {
    if (timer.current) clearTimeout(timer.current);
    setShown(false);
    setOpen(false);
  };

  useLayoutEffect(() => {
    if (!open) return;
    const r = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(r);
  }, [open]);

  if (content == null || content === "") return <>{children}</>;

  const pos: CSSProperties = !rect
    ? {}
    : side === "top"
      ? { top: rect.top - 6, left: rect.left + rect.width / 2, transformOrigin: "bottom center" }
      : side === "bottom"
        ? { top: rect.bottom + 6, left: rect.left + rect.width / 2, transformOrigin: "top center" }
        : side === "left"
          ? { top: rect.top + rect.height / 2, left: rect.left - 6, transformOrigin: "center right" }
          : { top: rect.top + rect.height / 2, left: rect.right + 6, transformOrigin: "center left" };
  const base =
    side === "top" ? "translate(-50%,-100%)" : side === "bottom" ? "translate(-50%,0)" : side === "left" ? "translate(-100%,-50%)" : "translate(0,-50%)";

  return (
    <>
      <span
        ref={ref}
        aria-describedby={open ? id : undefined}
        onMouseEnter={openLater}
        onMouseLeave={closeNow}
        onFocus={openLater}
        onBlur={closeNow}
        className="inline-flex"
      >
        {children}
      </span>
      {open &&
        rect &&
        createPortal(
          <div
            role="tooltip"
            id={id}
            style={{
              position: "fixed",
              ...pos,
              transform: `${base} scale(${shown ? 1 : 0.96})`,
              opacity: shown ? 1 : 0,
              transition: "opacity 140ms var(--ease-out-strong), transform 140ms var(--ease-out-strong)",
              maxWidth: "min(20rem, calc(100vw - 16px))",
            }}
            className={cn(
              "pointer-events-none z-[60] rounded-md border bg-popover px-2 py-1 text-micro font-medium leading-snug text-popover-foreground shadow-md",
              className,
            )}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
