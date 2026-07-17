import { type ComponentType, type ReactNode } from "react";
import { SearchX } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";

// ── The one table-empty decision ─────────────────────────────────────────────
// Research (Linear/Attio) splits the empty state in two: "no rows match your filters" (offer
// Clear filters) vs "nothing exists yet" (offer the create CTA). Every migrated surface renders
// this instead of a lone muted <p>, so the two cases never blur. Loading/error reuse the
// existing RowsSkeleton / ErrorState primitives.
export function DataTableEmpty({
  isFiltered,
  onClearFilters,
  icon,
  title,
  description,
  action,
}: {
  /** True when filters/search are active — the emptiness is "no match", not "nothing yet". */
  isFiltered: boolean;
  onClearFilters?: () => void;
  /** The nothing-yet identity (icon/title/description/CTA). */
  icon?: ComponentType<{ className?: string }>;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  if (isFiltered) {
    return (
      <EmptyState
        icon={SearchX}
        title="No matches"
        description="No rows match your current filters. Try loosening or clearing them."
        action={
          onClearFilters ? (
            <Button variant="outline" size="sm" onClick={onClearFilters}>
              Clear filters
            </Button>
          ) : undefined
        }
      />
    );
  }
  return <EmptyState icon={icon} title={title} description={description} action={action} />;
}
