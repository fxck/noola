import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { NoolaMark } from "@/components/noola-mark";

// Shared two-pane frame for every public auth surface (login / signup / forgot / reset /
// invite / join) so they read as one family. Left: the brand lockup + the route's own
// card(s), on a one-time pop-in entrance. Right: a branded amber noola-beam environment
// — a graphite panel with a radiating concentric-ring signal motif built from tokens, so
// it works in light AND dark; it collapses on narrow screens.
//
// Presentational only. Routes pass their existing card(s) as `children` (multi-state
// invite/join branches included) and any below-card content as `footer`; every form
// field, handler, link, and error state stays in the route.
interface AuthShellProps {
  children: ReactNode;
  /** Optional content rendered below the card (e.g. the "New to Noola?" link). */
  footer?: ReactNode;
  className?: string;
}

export function AuthShell({ children, footer, className }: AuthShellProps) {
  return (
    <div className={cn("grid min-h-dvh lg:grid-cols-[1fr_minmax(0,1.05fr)]", className)}>
      {/* form pane */}
      <main className="flex min-h-dvh flex-col items-center justify-center bg-background px-6 py-10">
        <div className="motion-pop w-full max-w-sm">
          <div className="mb-6 flex items-center justify-center gap-2.5">
            <NoolaMark />
            <span className="text-lg font-semibold tracking-tight">noola</span>
          </div>
          {children}
          {footer}
        </div>
      </main>

      <NoolaEnvironment />
    </div>
  );
}

// The branded right pane: concentric signal rings radiating from a lit amber core over a
// warm-graphite panel, with a quiet product line. Token-driven (bg-muted + reserved amber)
// so it reads right in both themes; ambient breathe respects reduced-motion. Decorative.
function NoolaEnvironment() {
  return (
    <aside
      aria-hidden="true"
      className="relative hidden overflow-hidden border-l border-border bg-muted lg:flex lg:flex-col"
    >
      {/* soft amber wash */}
      <div className="pointer-events-none absolute left-1/2 top-[42%] size-[130%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/[0.07] blur-3xl" />

      {/* radiating rings + lit core */}
      <div className="relative grid flex-1 place-items-center">
        <div className="col-start-1 row-start-1 size-[30rem] rounded-full border border-primary/10" />
        <div className="col-start-1 row-start-1 size-[22rem] rounded-full border border-primary/15" />
        <div className="col-start-1 row-start-1 size-[14rem] rounded-full border border-primary/20" />
        <div className="col-start-1 row-start-1 size-28 rounded-full border border-primary/25" />
        <div className="noola-breathe col-start-1 row-start-1 size-24 rounded-full bg-primary/20 motion-reduce:hidden" />
        <div className="col-start-1 row-start-1 size-3.5 rounded-full bg-primary shadow-[0_0_28px_4px_color-mix(in_oklab,var(--primary)_55%,transparent)]" />
      </div>

      {/* product line */}
      <div className="relative p-10 lg:p-12">
        <div className="mb-3 flex items-center gap-2.5">
          <NoolaMark className="size-8" />
          <span className="text-lg font-semibold tracking-tight text-foreground">noola</span>
        </div>
        <p className="max-w-sm text-lg font-semibold tracking-tight text-balance text-foreground">
          Every channel, one clear signal.
        </p>
        <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
          The support inbox with workflow automation built in — every channel in one thread, answered by your team, your flows, and an AI grounded in your docs.
        </p>
      </div>
    </aside>
  );
}
