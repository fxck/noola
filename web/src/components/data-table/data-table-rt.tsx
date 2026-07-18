import { useRef, useState, type KeyboardEvent } from "react";
import { flexRender, type Table as TanstackTable } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

type ColMeta = { align?: "right"; label?: string } | undefined;

/**
 * Renders a @tanstack/react-table instance as a dense, sortable table with a sticky header.
 * Sorting/selection/visibility/filtering all live on the passed `table` (the openstatus model:
 * one headless table drives columns, facets, sort, and column visibility). The parent owns
 * loading/empty states and renders this only with real rows.
 */
export function DataTableRT<T>({
  table,
  onRowClick,
  className,
}: {
  table: TanstackTable<T>;
  onRowClick?: (row: T) => void;
  className?: string;
}) {
  const rows = table.getRowModel().rows;
  // Roving-tabindex keyboard nav: one row is tabbable; arrows/j/k move focus,
  // Enter/Space activates. The table is the console's core triage verb.
  const [focused, setFocused] = useState(0);
  // Drag-to-reorder columns (Intercom-style). The selection column stays pinned first;
  // everything else can be dragged. Persistence is the parent's job via onColumnOrderChange.
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const reorder = (from: string, to: string) => {
    if (from === to || from === "select" || to === "select") return;
    const cur = table.getState().columnOrder;
    const ids = cur.length ? [...cur] : table.getAllLeafColumns().map((c) => c.id);
    const fromIdx = ids.indexOf(from);
    const toIdx = ids.indexOf(to);
    if (fromIdx < 0 || toIdx < 0) return;
    ids.splice(toIdx, 0, ids.splice(fromIdx, 1)[0]);
    table.setColumnOrder(ids);
  };
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const activeIdx = rows.length ? Math.min(focused, rows.length - 1) : 0;

  const focusRow = (i: number) => {
    if (!rows.length) return;
    const c = Math.max(0, Math.min(i, rows.length - 1));
    setFocused(c);
    requestAnimationFrame(() => {
      const el = bodyRef.current?.querySelector<HTMLElement>(`tr[data-row-index="${c}"]`);
      el?.focus();
      el?.scrollIntoView({ block: "nearest" });
    });
  };
  const onRowKeyDown = (e: KeyboardEvent<HTMLTableRowElement>, i: number, original: T) => {
    switch (e.key) {
      case "ArrowDown":
      case "j":
        e.preventDefault();
        focusRow(i + 1);
        break;
      case "ArrowUp":
      case "k":
        e.preventDefault();
        focusRow(i - 1);
        break;
      case "Home":
        e.preventDefault();
        focusRow(0);
        break;
      case "End":
        e.preventDefault();
        focusRow(rows.length - 1);
        break;
      case "Enter":
      case " ":
        if (onRowClick) {
          e.preventDefault();
          onRowClick(original);
        }
        break;
    }
  };

  return (
    <table className={cn("w-full border-separate border-spacing-0 text-sm", className)}>
      <thead className="sticky top-0 z-10 bg-card">
        {table.getHeaderGroups().map((hg) => (
          <tr key={hg.id}>
            {hg.headers.map((header) => {
              const meta = header.column.columnDef.meta as ColMeta;
              const right = meta?.align === "right";
              const canSort = header.column.getCanSort();
              const sorted = header.column.getIsSorted();
              const draggable = header.column.id !== "select" && !header.isPlaceholder;
              return (
                <th
                  key={header.id}
                  style={header.column.id === "select" ? { width: 40 } : undefined}
                  draggable={draggable}
                  onDragStart={draggable ? () => setDragId(header.column.id) : undefined}
                  onDragOver={
                    draggable
                      ? (e) => {
                          e.preventDefault();
                          setOverId(header.column.id);
                        }
                      : undefined
                  }
                  onDragLeave={
                    draggable ? () => setOverId((o) => (o === header.column.id ? null : o)) : undefined
                  }
                  onDrop={
                    draggable
                      ? (e) => {
                          e.preventDefault();
                          if (dragId) reorder(dragId, header.column.id);
                          setDragId(null);
                          setOverId(null);
                        }
                      : undefined
                  }
                  onDragEnd={() => {
                    setDragId(null);
                    setOverId(null);
                  }}
                  className={cn(
                    "border-b px-3 py-2 text-xs font-medium text-muted-foreground",
                    right ? "text-right" : "text-left",
                    draggable && "cursor-grab select-none",
                    dragId === header.column.id && "opacity-40",
                    overId === header.column.id &&
                      dragId &&
                      dragId !== header.column.id &&
                      "shadow-[inset_2px_0_0_var(--primary)]",
                  )}
                >
                  {header.isPlaceholder ? null : canSort ? (
                    <button
                      type="button"
                      onClick={header.column.getToggleSortingHandler()}
                      className={cn(
                        "group inline-flex items-center gap-1 rounded transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                        sorted && "text-foreground",
                        right && "flex-row-reverse",
                      )}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {sorted === "asc" ? (
                        <ArrowUp className="size-3" />
                      ) : sorted === "desc" ? (
                        <ArrowDown className="size-3" />
                      ) : (
                        <ChevronsUpDown className="size-3 opacity-0 group-hover:opacity-40" />
                      )}
                    </button>
                  ) : (
                    flexRender(header.column.columnDef.header, header.getContext())
                  )}
                </th>
              );
            })}
          </tr>
        ))}
      </thead>
      <tbody ref={bodyRef}>
        {rows.map((row, i) => {
          const selected = row.getIsSelected();
          return (
            <tr
              key={row.id}
              data-row-index={i}
              tabIndex={onRowClick ? (i === activeIdx ? 0 : -1) : undefined}
              role={onRowClick ? "button" : undefined}
              onClick={() => onRowClick?.(row.original)}
              onKeyDown={onRowClick ? (e) => onRowKeyDown(e, i, row.original) : undefined}
              onFocus={() => setFocused(i)}
              className={cn(
                "group outline-none transition-colors",
                onRowClick &&
                  "cursor-pointer focus-visible:relative focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                selected ? "bg-primary/5" : "hover:bg-muted/50",
              )}
            >
              {row.getVisibleCells().map((cell, ci) => {
                const meta = cell.column.columnDef.meta as ColMeta;
                return (
                  <td
                    key={cell.id}
                    className={cn(
                      "border-b border-border/60 px-3 py-2 align-middle",
                      meta?.align === "right" ? "text-right" : "text-left",
                      // Noola scan-bar — the same amber left-spine as the inbox rows,
                      // on the first cell so every list shares one row-identity language.
                      ci === 0 &&
                        (selected
                          ? "shadow-[inset_2px_0_0_var(--primary)]"
                          : "transition-shadow group-hover:shadow-[inset_2px_0_0_var(--primary)]"),
                    )}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
