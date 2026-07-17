import { createContext, useContext, useState, type ComponentType, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Popover } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const CloseCtx = createContext<() => void>(() => {});

/**
 * Dropdown menu on the app Popover — the chrome replacement for native <select>
 * elements and the shape behind icon-button overflow menus. The trigger is a
 * render prop so any button shape can wire its own onClick/aria state.
 */
export function Menu({
  trigger,
  children,
  align = "end",
  width = 208,
  className,
}: {
  trigger: (open: boolean, toggle: () => void) => ReactNode;
  children: ReactNode;
  align?: "start" | "end";
  width?: number;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align={align}
      width={width}
      className={className}
      trigger={trigger(open, () => setOpen((o) => !o))}
    >
      <CloseCtx.Provider value={() => setOpen(false)}>
        <div className="p-1">{children}</div>
      </CloseCtx.Provider>
    </Popover>
  );
}

export function MenuItem({
  icon: Icon,
  leading,
  label,
  hint,
  selected,
  destructive,
  disabled,
  keepOpen,
  onSelect,
}: {
  icon?: ComponentType<{ className?: string }>;
  /** custom leading node (color dot, avatar) when an icon isn't right */
  leading?: ReactNode;
  label: string;
  /** quiet right-aligned hint, e.g. a keyboard key */
  hint?: string;
  /** pass a boolean (even false) to reserve the check column — pickers */
  selected?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  keepOpen?: boolean;
  onSelect?: () => void;
}) {
  const close = useContext(CloseCtx);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        if (!keepOpen) close();
        onSelect?.();
      }}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-small transition-colors",
        destructive ? "text-destructive hover:bg-destructive/10" : "hover:bg-accent",
        disabled && "pointer-events-none opacity-50",
      )}
    >
      {Icon && <Icon className={cn("size-3.5 shrink-0", !destructive && "text-muted-foreground")} />}
      {leading}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="shrink-0 font-mono text-micro text-muted-foreground/70">{hint}</span>}
      {selected !== undefined && (
        <Check className={cn("size-3.5 shrink-0 text-primary", !selected && "opacity-0")} />
      )}
    </button>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="-mx-1 my-1 h-px bg-border/60" />;
}

/**
 * A quiet value-row picker (STRUCTURE.md §6): renders as inline text + chevron,
 * opens a proper menu on click. The app's replacement for native <select> in
 * detail rails and chrome.
 */
export function PopoverSelect({
  value,
  options,
  onChange,
  disabled,
  placeholder = "—",
  align = "end",
  buttonClassName,
}: {
  value: string | null;
  options: { value: string | null; label: string; dot?: ReactNode }[];
  onChange: (v: string | null) => void;
  disabled?: boolean;
  placeholder?: string;
  align?: "start" | "end";
  buttonClassName?: string;
}) {
  const current = options.find((o) => (o.value ?? "") === (value ?? ""));
  return (
    <Menu
      align={align}
      width={192}
      trigger={(open, toggle) => (
        <button
          type="button"
          disabled={disabled}
          onClick={toggle}
          aria-haspopup="listbox"
          aria-expanded={open}
          className={cn(
            "group/ps -my-0.5 inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-small transition-colors hover:bg-muted/60 disabled:opacity-50",
            (!current || current.value === null) && "text-muted-foreground",
            buttonClassName,
          )}
        >
          {current?.dot}
          <span className="truncate">{current ? current.label : placeholder}</span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground/50 transition-colors group-hover/ps:text-muted-foreground" />
        </button>
      )}
    >
      {options.map((o) => (
        <MenuItem
          key={o.value ?? "__none"}
          label={o.label}
          leading={o.dot}
          selected={(o.value ?? "") === (value ?? "")}
          onSelect={() => onChange(o.value)}
        />
      ))}
    </Menu>
  );
}
