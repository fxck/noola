import { type ComponentType } from "react";
import { Inbox } from "lucide-react";
import { cn } from "@/lib/utils";
import type { KbCollection } from "@/lib/kb";
import type { ComboOption } from "@/components/ui/combobox";

// Shared vocabulary for the KB collections surface: the curated color palette a
// collection can wear, the little color dot that identifies it everywhere, and the
// helpers that turn a collection list into Combobox / CommandMenu options.

/** Curated collection colors — mid-tone hues that read on both light and dark. */
export const COLLECTION_COLORS = [
  "#64748b", // slate
  "#ef4444", // red
  "#f97316", // orange
  "#eab308", // amber
  "#22c55e", // green
  "#14b8a6", // teal
  "#3b82f6", // blue
  "#6366f1", // indigo
  "#a855f7", // purple
  "#ec4899", // pink
] as const;

export const DEFAULT_COLLECTION_COLOR = COLLECTION_COLORS[6]; // blue

/** The identity dot for a collection. Falls back to the muted token (uncategorized). */
export function CollectionDot({
  color,
  className,
}: {
  color?: string | null;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "size-2.5 shrink-0 rounded-full ring-1 ring-inset ring-foreground/10",
        className,
      )}
      style={{ backgroundColor: color || "var(--muted-foreground, #94a3b8)" }}
    />
  );
}

/** A color dot packaged as a `ComboOption.icon` (centered inside the icon slot). */
export function collectionIcon(color?: string | null): ComponentType<{ className?: string }> {
  function CollectionOptionDot({ className }: { className?: string }) {
    return (
      <span className={cn("grid place-items-center", className)}>
        <CollectionDot color={color} />
      </span>
    );
  }
  return CollectionOptionDot;
}

/**
 * Build the option list for a collection Combobox / CommandMenu. Prepends an
 * "Uncategorized" entry (value `"none"`) unless opted out.
 */
export function collectionOptions(
  collections: KbCollection[],
  opts: { includeUncategorized?: boolean; uncategorizedLabel?: string } = {},
): ComboOption[] {
  const { includeUncategorized = true, uncategorizedLabel = "Uncategorized" } = opts;
  const options: ComboOption[] = [];
  if (includeUncategorized) {
    options.push({ value: "none", label: uncategorizedLabel, icon: Inbox });
  }
  for (const c of collections) {
    options.push({ value: c.id, label: c.name, icon: collectionIcon(c.color) });
  }
  return options;
}
