import { cn } from "@/lib/utils";

// The Noola "oo" mark — the two o's of the name as two nodes of a flow: a graphite ring (the
// open conversation loop) beside the lit amber dot (the answer / the signal). Ring follows
// `currentColor` (graphite via muted-foreground by default); the dot is the reserved signal
// amber. Geometric, reads at nav-chip size and down to a 16px favicon (same construction).
export function NoolaMark({ className }: { className?: string }) {
  return (
    <span className={cn("grid size-7 place-items-center text-muted-foreground", className)}>
      <svg viewBox="0 0 24 24" className="size-full" aria-hidden="true">
        <circle cx="7" cy="12" r="4.1" fill="none" stroke="currentColor" strokeWidth="2.1" />
        <circle cx="16.4" cy="12" r="4.35" fill="var(--primary)" />
      </svg>
    </span>
  );
}
