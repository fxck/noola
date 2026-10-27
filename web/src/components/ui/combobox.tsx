import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover } from "./popover";

export interface ComboOption {
  value: string;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  /** right-aligned hint — e.g. a faceted count */
  hint?: string | number;
}

/**
 * The searchable, keyboard-navigable option list behind Combobox / MultiSelect / faceted
 * filters — the app's real replacement for native <select>. Arrow keys move a highlighted
 * row, Enter toggles it, typing filters. `multiple` renders checkboxes; single renders a
 * check on the selected row.
 */
export function CommandMenu({
  options,
  selected,
  onToggle,
  multiple,
  searchable = true,
  searchPlaceholder = "Search…",
  emptyText = "No results.",
  footer,
}: {
  options: ComboOption[];
  selected: ReadonlySet<string>;
  onToggle: (value: string) => void;
  multiple?: boolean;
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyText?: string;
  footer?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q),
    );
  }, [options, query]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const o = filtered[active];
      if (o) onToggle(o.value);
    } else if (e.key === "Home") {
      setActive(0);
    } else if (e.key === "End") {
      setActive(filtered.length - 1);
    }
  }

  return (
    <div className="flex max-h-80 w-full flex-col">
      {searchable && (
        <div className="flex items-center gap-2 border-b px-2.5">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={searchPlaceholder}
            className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            aria-label={searchPlaceholder}
          />
        </div>
      )}
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1" role="listbox">
        {filtered.length === 0 ? (
          <div className="px-2 py-6 text-center text-xs text-muted-foreground">{emptyText}</div>
        ) : (
          filtered.map((o, i) => {
            const on = selected.has(o.value);
            const Icon = o.icon;
            return (
              <button
                key={o.value}
                type="button"
                data-idx={i}
                role="option"
                aria-selected={on}
                onMouseEnter={() => setActive(i)}
                onClick={() => onToggle(o.value)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                  i === active ? "bg-accent text-accent-foreground" : "text-foreground",
                )}
              >
                {multiple ? (
                  <span
                    className={cn(
                      "grid size-4 shrink-0 place-items-center rounded border",
                      on ? "border-primary bg-primary text-primary-foreground" : "border-input",
                    )}
                  >
                    {on && <Check className="size-3" />}
                  </span>
                ) : (
                  <Check className={cn("size-4 shrink-0", on ? "opacity-100" : "opacity-0")} />
                )}
                {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" />}
                <span className="flex-1 truncate">{o.label}</span>
                {o.hint != null && o.hint !== "" && (
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{o.hint}</span>
                )}
              </button>
            );
          })
        )}
      </div>
      {footer}
    </div>
  );
}

/** Single-select combobox — the drop-in for a native <select>. */
export function Combobox({
  value,
  onChange,
  options,
  placeholder = "Select…",
  className,
  triggerClassName,
  align,
  searchable,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  options: ComboOption[];
  placeholder?: string;
  className?: string;
  /** Applied to the Popover's trigger *wrapper* (inline-flex by default). Pass `flex w-full`
   *  to make the combobox a block-level, full-width form field that stacks below its label
   *  instead of flowing inline beside it. */
  triggerClassName?: string;
  align?: "start" | "end";
  searchable?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = useMemo(() => new Set(value ? [value] : []), [value]);
  const current = options.find((o) => o.value === value);
  const Icon = current?.icon;
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align={align}
      triggerClassName={triggerClassName}
      width={Math.max(200, 0)}
      trigger={
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
          className={cn(
            "inline-flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-sm shadow-sm transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
        >
          <span className={cn("flex min-w-0 items-center gap-2", !current && "text-muted-foreground")}>
            {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" />}
            <span className="truncate">{current?.label ?? placeholder}</span>
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </button>
      }
    >
      <CommandMenu
        options={options}
        selected={selected}
        searchable={searchable ?? options.length > 8}
        onToggle={(v) => {
          onChange(v);
          setOpen(false);
        }}
      />
    </Popover>
  );
}

/** Multi-select — checkbox list in a popover. Trigger shows a count badge. */
export function MultiSelect({
  values,
  onChange,
  options,
  label,
  icon: TriggerIcon,
  className,
  align,
  searchable,
}: {
  values: string[];
  onChange: (values: string[]) => void;
  options: ComboOption[];
  label: string;
  icon?: ComponentType<{ className?: string }>;
  className?: string;
  align?: "start" | "end";
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = useMemo(() => new Set(values), [values]);
  function toggle(v: string) {
    onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v]);
  }
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align={align}
      width={220}
      trigger={
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-md border border-dashed border-input bg-background px-2.5 text-xs font-medium transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
        >
          {TriggerIcon && <TriggerIcon className="size-3.5 text-muted-foreground" />}
          {label}
          {values.length > 0 && (
            <span className="ml-0.5 rounded bg-primary/10 px-1.5 py-0.5 text-micro tabular-nums text-primary">
              {values.length}
            </span>
          )}
        </button>
      }
    >
      <CommandMenu
        options={options}
        selected={selected}
        multiple
        searchable={searchable ?? options.length > 8}
        onToggle={toggle}
        footer={
          values.length > 0 ? (
            <button
              type="button"
              onClick={() => onChange([])}
              className="w-full border-t px-2 py-2 text-center text-xs text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          ) : undefined
        }
      />
    </Popover>
  );
}
