import { cva, type VariantProps } from "class-variance-authority";
import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

// The one segmented control — a value-toggle sitting in a pane-header slot (STRUCTURE.md §3:
// a view switch is always the same control in the same place). Replaces the ~20 hand-rolled
// `inline-flex rounded bg-muted` bars scattered across analytics, composer, block-composer,
// context-rail, etc. Value-based (controlled): for ROUTE switches that need a real href
// (People|Companies, Inbox conversation|table) keep <Link role=tab> — this is for in-page
// state toggles. The active segment lifts onto the page surface (bg-background + shadow).

const rootVariants = cva(
  "inline-flex items-center gap-0.5 rounded-lg border bg-muted/60 p-0.5",
);

const itemVariants = cva(
  "relative inline-flex select-none items-center justify-center gap-1.5 rounded-md font-medium " +
    "transition-[color,background-color,box-shadow] duration-150 ease-[var(--ease-out-strong)] " +
    "active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100 " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
    "disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0 " +
    "aria-selected:bg-background aria-selected:text-foreground aria-selected:shadow-sm " +
    "[&:not([aria-selected=true])]:text-muted-foreground [&:not([aria-selected=true])]:hover:text-foreground",
  {
    variants: {
      size: {
        sm: "h-7 px-2 text-xs",
        md: "h-8 px-2.5 text-xs",
      },
      iconOnly: { true: "aspect-square px-0", false: "" },
    },
    defaultVariants: { size: "md", iconOnly: false },
  },
);

export interface SegmentedOption<T extends string> {
  value: T;
  /** Visible label. Omit for an icon-only segment (then `aria-label` is required). */
  label?: ReactNode;
  icon?: ReactNode;
  /** A small count chip trailing the label (e.g. an unread/result count). */
  badge?: ReactNode;
  /** Required for icon-only segments; also drives the native tooltip. */
  "aria-label"?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string>
  extends VariantProps<typeof itemVariants> {
  value: T;
  onValueChange: (value: T) => void;
  options: SegmentedOption<T>[];
  /** Labels the tablist for assistive tech (e.g. "Inbox view", "Window"). */
  "aria-label"?: string;
  className?: string;
}

export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  size,
  className,
  "aria-label": ariaLabel,
}: SegmentedControlProps<T>) {
  return (
    <div role="tablist" aria-label={ariaLabel} className={cn(rootVariants(), className)}>
      {options.map((opt) => {
        const selected = opt.value === value;
        const iconOnly = opt.icon != null && opt.label == null;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-label={opt["aria-label"]}
            title={opt["aria-label"]}
            disabled={opt.disabled}
            onClick={() => onValueChange(opt.value)}
            className={cn(itemVariants({ size, iconOnly }))}
          >
            {opt.icon}
            {opt.label}
            {opt.badge != null && (
              <span className="rounded bg-muted-foreground/15 px-1.5 py-px text-micro font-semibold tabular-nums text-muted-foreground">
                {opt.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
