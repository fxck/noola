import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

type Measure = "console" | "editorial" | "narrow" | "full";

const MEASURE: Record<Measure, string> = {
  // Wide, left-anchored operational surface (Linear-grade consoles + tables).
  console: "max-w-7xl",
  // ~768px reading measure for long-form authoring/reading (KB, broadcasts, help).
  editorial: "max-w-3xl",
  // ~672px single-column forms (settings panes, compose).
  narrow: "max-w-2xl",
  // No cap — the surface owns its own width (split panes).
  full: "max-w-none",
};

/**
 * The one page-width primitive. Replaces ~35 copy-pasted `mx-auto max-w-* p-6`
 * wrappers with the north-star's deliberate registers: a wide left-anchored
 * `console` for operational surfaces, an `editorial` reading measure for prose,
 * and `narrow` for forms. Left-anchors by default so consoles sit against the
 * nav rail instead of floating centered in dead margin. Scroll is owned by the
 * shell's <main>, so this is purely max-width + padding.
 */
export function PageContainer({
  measure = "console",
  align = "start",
  className,
  children,
}: {
  measure?: Measure;
  /** "start" left-anchors against the rail (consoles); "center" centers (editorial). */
  align?: "start" | "center";
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("w-full p-6", MEASURE[measure], align === "center" && "mx-auto", className)}>
      {children}
    </div>
  );
}
