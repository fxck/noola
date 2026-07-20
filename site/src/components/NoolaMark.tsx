// The Noola "oo" mark — the two o's of the name as two nodes of a flow: a graphite ring
// (the open conversation loop) beside the lit amber dot (the answer / the signal). The ring
// follows currentColor (graphite); the dot is the reserved signal amber. Same construction
// as the product's NoolaMark and the favicon — geometric, legible from nav-chip to 16px.
export function NoolaMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{ display: "block" }}
    >
      {/* ring follows currentColor (set graphite by the parent); dot is the reserved signal amber */}
      <circle cx="7" cy="12" r="4.1" fill="none" stroke="currentColor" strokeWidth="2.1" />
      <circle cx="16.4" cy="12" r="4.35" fill="var(--primary)" />
    </svg>
  );
}

/** The full wordmark — the "oo" mark beside the name, lowercase and tight, as in the app chrome. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={"inline-flex items-center gap-2 " + (className ?? "")}>
      <NoolaMark size={22} className="text-muted-foreground" />
      <span className="text-[1.05rem] font-semibold tracking-tight text-foreground">noola</span>
    </span>
  );
}
