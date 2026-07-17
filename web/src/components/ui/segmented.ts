// Segmented-control tab styling — the view-switch pattern (§3: a view switch is
// a pane-header control, always the same slot). An active tab lifts onto the
// card surface.
export const TAB_BASE =
  "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
export const TAB_ON = "bg-card text-foreground shadow-sm";
export const TAB_OFF = "text-muted-foreground hover:text-foreground";
export const TAB_BADGE =
  "rounded bg-muted-foreground/15 px-1.5 py-px text-micro font-semibold tabular-nums text-muted-foreground";
