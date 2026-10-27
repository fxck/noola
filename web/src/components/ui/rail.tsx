import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useLocalFlag } from "@/lib/use-local-flag";
import { cn } from "@/lib/utils";

// The facts-rail primitives (STRUCTURE.md §6) — promoted from the inbox context
// rail so every entity page (contact, company, source, broadcast) speaks the
// same label/value + collapsible-section language.

/** One label/value fact row — label muted left, value right, 13px. */
export function FactRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-small">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 justify-end text-right text-foreground">{children}</dd>
    </div>
  );
}

/** One collapsible rail section — icon + title + chevron on a full-bleed
 *  hairline row; the open state persists in localStorage. Children mount on
 *  first open only, so fetching sections stay lazy. */
export function RailSection({
  id,
  icon: Icon,
  title,
  count,
  defaultOpen = false,
  children,
}: {
  id: string;
  icon: ComponentType<{ className?: string }>;
  title: string;
  count?: number;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useLocalFlag(`noola.rail.${id}`, defaultOpen);
  const [everOpen, setEverOpen] = useState(open);
  useEffect(() => {
    if (open) setEverOpen(true);
  }, [open]);

  return (
    <section className="border-t border-border/50">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex h-10 w-full items-center gap-2 px-4 text-small font-semibold tracking-tight transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 text-left">{title}</span>
        {typeof count === "number" && count > 0 && !open && (
          <span className="text-xs font-normal tabular-nums text-muted-foreground">{count}</span>
        )}
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-150 ease-[var(--ease-out-strong)] motion-reduce:transition-none",
            !open && "-rotate-90",
          )}
        />
      </button>
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-[var(--ease-out-strong)] motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden">
          <div className="px-4 pb-3">{everOpen ? children : null}</div>
        </div>
      </div>
    </section>
  );
}
