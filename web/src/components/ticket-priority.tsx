import { cn } from "@/lib/utils";
import type { TicketPriority } from "@/lib/tickets";

// Priority visual vocabulary — one source of truth for the table chip, the detail selector,
// and anywhere else priority renders. Semantic colour (not the brand accent): urgent reads at a
// glance, low recedes.
export const PRIORITY_META: Record<TicketPriority, { label: string; dot: string; chip: string }> = {
  urgent: {
    label: "Urgent",
    dot: "bg-destructive",
    chip: "border-destructive/30 bg-destructive/10 text-destructive",
  },
  high: {
    label: "High",
    dot: "bg-amber-500",
    chip: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  normal: {
    label: "Normal",
    dot: "bg-slate-400",
    chip: "border-border bg-muted text-muted-foreground",
  },
  low: {
    label: "Low",
    dot: "bg-slate-300 dark:bg-slate-600",
    chip: "border-border bg-transparent text-muted-foreground/70",
  },
};

export function PriorityBadge({ priority, className }: { priority: TicketPriority; className?: string }) {
  const m = PRIORITY_META[priority] ?? PRIORITY_META.normal;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
        m.chip,
        className,
      )}
    >
      <span className={cn("size-1.5 rounded-full", m.dot)} />
      {m.label}
    </span>
  );
}
