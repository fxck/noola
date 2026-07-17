import { type ReactNode, useState } from "react";
import { Layers, Inbox, Lightbulb, Plus, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import type { KbCollection } from "@/lib/kb";
import { CollectionDot } from "./collection-common";

/** Per-collection article tallies, computed from the loaded article list. */
export interface RailCounts {
  all: number;
  none: number;
  byId: Record<string, number>;
}

const ROW_BASE =
  "group/row flex items-center gap-2 rounded-md pl-2 pr-1 text-sm transition-colors";
const ROW_ON = "bg-muted font-medium text-foreground";
const ROW_OFF = "text-muted-foreground hover:bg-muted hover:text-foreground";

function CountBadge({ n, active }: { n: number; active: boolean }) {
  if (n <= 0) return null;
  return (
    <Badge
      variant="muted"
      className={cn(
        "px-1.5 py-0 text-micro tabular-nums",
        active && "bg-background/70 text-foreground",
      )}
    >
      {n}
    </Badge>
  );
}

function SpecialRow({
  icon: Icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: typeof Layers;
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(ROW_BASE, "h-8 w-full text-left", active ? ROW_ON : ROW_OFF)}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="flex-1 truncate">{label}</span>
      <CountBadge n={count} active={active} />
    </button>
  );
}

/**
 * The KB collections rail. Lists "All articles", "Uncategorized", then each
 * collection (color dot · name · count) with a per-row ⋯ menu (Rename / Delete)
 * and a "New collection" affordance. The selected entry is driven by the caller
 * (the `?collection` search param) — `selected`: undefined = All, "none" =
 * uncategorized, otherwise a collection id.
 */
export function CollectionRail({
  collections,
  counts,
  gapCount = 0,
  selected,
  loading,
  onSelect,
  onNew,
  onRename,
  onDelete,
  className,
}: {
  collections: KbCollection[];
  counts: RailCounts;
  /** Open knowledge gaps — shows the "Gaps" worklist entry while > 0. */
  gapCount?: number;
  selected: string | undefined;
  loading?: boolean;
  onSelect: (collection: string | undefined) => void;
  onNew: () => void;
  onRename: (collection: KbCollection) => void;
  onDelete: (collection: KbCollection) => void;
  className?: string;
}) {
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const sorted = [...collections].sort((a, b) => a.position - b.position);

  let body: ReactNode;
  if (loading && collections.length === 0) {
    body = (
      <div className="grid place-items-center py-8">
        <Spinner className="size-4" />
      </div>
    );
  } else if (sorted.length === 0) {
    body = (
      <p className="px-2 py-3 text-xs leading-relaxed text-muted-foreground/70">
        No collections yet. Group related articles so they're easier to find.
      </p>
    );
  } else {
    body = (
      <ul className="flex flex-col gap-0.5">
        {sorted.map((c) => {
          const active = selected === c.id;
          const menuOpen = menuOpenId === c.id;
          return (
            <li key={c.id}>
              <div className={cn(ROW_BASE, "h-8", active ? ROW_ON : ROW_OFF)}>
                <button
                  type="button"
                  onClick={() => onSelect(c.id)}
                  aria-current={active ? "page" : undefined}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  title={c.description || c.name}
                >
                  <CollectionDot color={c.color} />
                  <span className="flex-1 truncate">{c.name}</span>
                </button>
                <CountBadge n={counts.byId[c.id] ?? 0} active={active} />
                <Popover
                  open={menuOpen}
                  onOpenChange={(o) => setMenuOpenId(o ? c.id : null)}
                  align="end"
                  width={168}
                  trigger={
                    <button
                      type="button"
                      aria-label={`Actions for ${c.name}`}
                      aria-haspopup="menu"
                      onClick={() => setMenuOpenId((cur) => (cur === c.id ? null : c.id))}
                      className={cn(
                        "grid size-6 shrink-0 place-items-center rounded text-muted-foreground transition-[opacity,color] hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none",
                        menuOpen
                          ? "opacity-100"
                          : "opacity-0 group-hover/row:opacity-100",
                      )}
                    >
                      <MoreHorizontal className="size-4" />
                    </button>
                  }
                >
                  <div className="p-1" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpenId(null);
                        onRename(c);
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                    >
                      <Pencil className="size-3.5 text-muted-foreground" /> Rename
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpenId(null);
                        onDelete(c);
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-destructive transition-colors hover:bg-destructive/10"
                    >
                      <Trash2 className="size-3.5" /> Delete
                    </button>
                  </div>
                </Popover>
              </div>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <aside
      className={cn(
        "w-60 shrink-0 flex-col border-r bg-card/20",
        className,
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
        <SpecialRow
          icon={Layers}
          label="All articles"
          count={counts.all}
          active={selected === undefined}
          onClick={() => onSelect(undefined)}
        />
        <SpecialRow
          icon={Inbox}
          label="Uncategorized"
          count={counts.none}
          active={selected === "none"}
          onClick={() => onSelect("none")}
        />
        {(gapCount > 0 || selected === "gaps") && (
          <SpecialRow
            icon={Lightbulb}
            label="Gaps"
            count={gapCount}
            active={selected === "gaps"}
            onClick={() => onSelect("gaps")}
          />
        )}

        <div className="mb-1 mt-3 flex items-center justify-between px-2">
          <span className="text-micro font-medium uppercase tracking-wide text-muted-foreground/80">
            Collections
          </span>
          <button
            type="button"
            onClick={onNew}
            title="New collection"
            aria-label="New collection"
            className="grid size-5 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus className="size-4" />
          </button>
        </div>

        {body}

        <Button
          variant="ghost"
          size="sm"
          onClick={onNew}
          className="mt-1 justify-start gap-2 text-muted-foreground hover:text-foreground"
        >
          <Plus className="size-4" /> New collection
        </Button>
      </div>
    </aside>
  );
}
