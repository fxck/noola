// Rows-per-page control for the server-paginated tables (contacts, companies). Shared so both
// customer tables offer the same choices and read identically.
export const PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;
export const DEFAULT_PAGE_SIZE = 25;

export function PageSizeSelect({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="hidden sm:inline">Rows</span>
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label="Rows per page"
        className="h-7 rounded-md border bg-background px-1.5 text-xs tabular-nums transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {PAGE_SIZE_OPTIONS.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </label>
  );
}
