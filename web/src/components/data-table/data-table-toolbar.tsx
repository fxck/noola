import { type ComponentType, type ReactNode } from "react";
import type { Table as TanstackTable } from "@tanstack/react-table";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { MultiSelect, type ComboOption } from "@/components/ui/combobox";
import { cn } from "@/lib/utils";
import { FacetedFilter } from "./faceted-filter";

export interface FacetConfig {
  columnId: string;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  staticOptions?: ComboOption[];
}

function ColumnVisibility<T>({ table }: { table: TanstackTable<T> }) {
  const cols = table.getAllColumns().filter((c) => c.getCanHide());
  const options: ComboOption[] = cols.map((c) => ({
    value: c.id,
    label: (c.columnDef.meta as { label?: string } | undefined)?.label ?? c.id,
  }));
  const values = cols.filter((c) => c.getIsVisible()).map((c) => c.id);
  return (
    <MultiSelect
      label="View"
      icon={SlidersHorizontal}
      align="end"
      searchable={false}
      values={values}
      options={options}
      onChange={(vis) => cols.forEach((c) => c.toggleVisibility(vis.includes(c.id)))}
    />
  );
}

/**
 * The table toolbar: a global search, the faceted filters, an optional +Filter builder slot, a
 * reset, and a column-visibility menu — the openstatus data-table toolbar, native.
 * `search`/`onSearchChange` drive the table's globalFilter; `filter` slots the +Filter builder
 * (attribute filters, separate popover from facets per Linear's doctrine); `right` slots extra
 * actions (Add / Import). Pass `count`+`noun` to render the "39 messages" result headline.
 */
export function DataTableToolbar<T>({
  table,
  search,
  onSearchChange,
  facets,
  filter,
  right,
  searchPlaceholder = "Search name, email, company…",
  onReset,
}: {
  table: TanstackTable<T>;
  search: string;
  onSearchChange: (v: string) => void;
  facets: FacetConfig[];
  /** The "+ Filter" attribute-filter builder (kept a separate popover from the facets). */
  filter?: ReactNode;
  right?: ReactNode;
  searchPlaceholder?: string;
  /** Also clear surface-level (attribute-builder) filters on Reset. */
  onReset?: () => void;
}) {
  const isFiltered = table.getState().columnFilters.length > 0 || search.trim().length > 0;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={searchPlaceholder}
          className="h-8 w-52 pl-8 sm:w-64"
          aria-label="Search"
        />
      </div>
      {facets.map((f) => (
        <FacetedFilter
          key={f.columnId}
          column={table.getColumn(f.columnId)}
          label={f.label}
          icon={f.icon}
          staticOptions={f.staticOptions}
        />
      ))}
      {filter}
      {(isFiltered || onReset) && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1 px-2 text-xs"
          onClick={() => {
            table.resetColumnFilters();
            onSearchChange("");
            onReset?.();
          }}
        >
          Reset <X className="size-3.5" />
        </Button>
      )}
      <div className="ml-auto flex items-center gap-2">
        <ColumnVisibility table={table} />
        {right}
      </div>
    </div>
  );
}

/** The "39 messages" result-count headline — a first-class toolbar element (UX diagnosis §4b),
 *  standardized so every surface states its size the same way. */
export function ResultCount({ count, noun, className }: { count: number; noun: string; className?: string }) {
  const label = count !== 1 ? noun : noun.endsWith("ies") ? `${noun.slice(0, -3)}y` : noun.replace(/s$/, "");
  return (
    <span className={cn("text-sm font-semibold text-foreground tabular-nums", className)}>
      {count.toLocaleString()} <span className="font-normal text-muted-foreground">{label}</span>
    </span>
  );
}
