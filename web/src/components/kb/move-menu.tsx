import { useMemo, useState } from "react";
import { FolderInput } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover } from "@/components/ui/popover";
import { CommandMenu } from "@/components/ui/combobox";
import type { KbCollection } from "@/lib/kb";
import { collectionOptions } from "./collection-common";

/**
 * "Move to…" — a searchable popover of collections (+ Uncategorized) for reassigning
 * an article. `value` is the article's current `collection_id` (null = uncategorized);
 * `onMove` receives the destination id, or null for Uncategorized. Renders a compact
 * ghost icon button by default, or a labeled outline button when `label` is given.
 */
export function MoveToMenu({
  collections,
  value,
  onMove,
  label,
  align = "end",
  disabled,
}: {
  collections: KbCollection[];
  value: string | null;
  onMove: (collectionId: string | null) => void;
  /** When set, renders a labeled button instead of the bare icon trigger. */
  label?: string;
  align?: "start" | "end";
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const options = useMemo(() => collectionOptions(collections), [collections]);
  const selected = useMemo(() => new Set([value ?? "none"]), [value]);

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align={align}
      width={224}
      trigger={
        label ? (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={disabled}
            aria-haspopup="menu"
            onClick={() => setOpen((o) => !o)}
          >
            <FolderInput className="size-3.5" /> {label}
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground hover:text-foreground"
            aria-label="Move to collection"
            aria-haspopup="menu"
            disabled={disabled}
            onClick={() => setOpen((o) => !o)}
          >
            <FolderInput className="size-4" />
          </Button>
        )
      }
    >
      <CommandMenu
        options={options}
        selected={selected}
        searchable={options.length > 8}
        searchPlaceholder="Move to…"
        emptyText="No collections yet."
        onToggle={(v) => {
          onMove(v === "none" ? null : v);
          setOpen(false);
        }}
      />
    </Popover>
  );
}
