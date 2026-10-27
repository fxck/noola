import { PopoverSelect } from "@/components/ui/menu";

// Rows-per-page control for the server-paginated tables (contacts, companies). Shared so both
// customer tables offer the same choices and read identically. Uses the app's PopoverSelect
// primitive (not a native <select>) so it matches every other select-style control.
export const PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;
export const DEFAULT_PAGE_SIZE = 25;

export function PageSizeSelect({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="hidden sm:inline">Rows</span>
      <PopoverSelect
        value={String(value)}
        options={PAGE_SIZE_OPTIONS.map((n) => ({ value: String(n), label: String(n) }))}
        onChange={(v) => v && onChange(Number(v))}
        align="end"
        buttonClassName="tabular-nums"
      />
    </label>
  );
}
