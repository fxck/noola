import { Link } from "@tanstack/react-router";
import { TAB_BASE, TAB_ON, TAB_OFF } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";

/**
 * People | Companies | Map — the Customers surface's view switch (§3: a view switch
 * is a pane-header control, always the same slot). One nav entity, three views
 * of the same customer base; routes stay /contacts, /companies, /contacts/map.
 */
export function CustomersViewSwitch({ current }: { current: "people" | "companies" | "map" }) {
  return (
    <div
      role="tablist"
      aria-label="Customers views"
      className="inline-flex items-center gap-0.5 rounded-lg border bg-muted/60 p-0.5"
    >
      <Link
        to="/contacts"
        role="tab"
        aria-selected={current === "people"}
        className={cn(TAB_BASE, current === "people" ? TAB_ON : TAB_OFF)}
      >
        People
      </Link>
      <Link
        to="/companies"
        role="tab"
        aria-selected={current === "companies"}
        className={cn(TAB_BASE, current === "companies" ? TAB_ON : TAB_OFF)}
      >
        Companies
      </Link>
      <Link
        to="/contacts/map"
        role="tab"
        aria-selected={current === "map"}
        className={cn(TAB_BASE, current === "map" ? TAB_ON : TAB_OFF)}
      >
        Map
      </Link>
    </div>
  );
}
