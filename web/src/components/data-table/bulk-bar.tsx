import { type ComponentType, useEffect, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

// ── Shared bulk-action bar ───────────────────────────────────────────────────
// One bottom-floating action bar for every table surface (UX diagnosis §4b), replacing the
// per-surface header-swap clusters. Actions gate with a reason (Intercom can't bulk-delete a
// live send) — a disabled action shows WHY on hover instead of vanishing.

export interface BulkAction {
  key: string;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  onClick: () => void;
  /** When set, the action is disabled and this text explains why (shown on hover). */
  disabledReason?: string;
  destructive?: boolean;
}

export function BulkBar({
  count,
  actions,
  onClear,
  busy,
}: {
  count: number;
  actions: BulkAction[];
  onClear: () => void;
  busy?: boolean;
}) {
  // Mount-transition entrance (ease-out slide-up, no keyframe dep). Fires when a selection begins.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(r);
  }, []);
  if (count === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
      <div
        role="toolbar"
        aria-label={`${count} selected`}
        className={cn(
          "pointer-events-auto flex items-center gap-1 rounded-full border bg-card/95 py-1.5 pl-4 pr-1.5 shadow-lg ring-1 ring-black/5 backdrop-blur transition-[transform,opacity] duration-200 ease-out",
          shown ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0",
          busy && "opacity-70",
        )}
      >
        <span className="text-sm font-semibold tabular-nums">{count}</span>
        <span className="text-sm text-muted-foreground">selected</span>
        <div className="mx-1.5 h-5 w-px bg-border" />
        {actions.map((a) => {
          const disabled = !!a.disabledReason || busy;
          const btn = (
            <Button
              key={a.key}
              variant={a.destructive ? "ghost" : "ghost"}
              size="sm"
              disabled={disabled}
              onClick={a.onClick}
              className={cn("h-8 gap-1.5 rounded-full px-3 text-xs", a.destructive && "text-destructive hover:bg-destructive/10 hover:text-destructive")}
            >
              {a.icon && <a.icon className="size-3.5" />}
              {a.label}
            </Button>
          );
          // A disabled button doesn't fire hover events in every browser, so the reason lives on
          // a wrapping span with the native title.
          return a.disabledReason ? (
            <span key={a.key} title={a.disabledReason} className="inline-flex cursor-not-allowed">
              {btn}
            </span>
          ) : (
            btn
          );
        })}
        <div className="mx-1 h-5 w-px bg-border" />
        <Button variant="ghost" size="sm" onClick={onClear} className="size-8 rounded-full p-0" aria-label="Clear selection">
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
}

// ── Select-all-N-matching banner ─────────────────────────────────────────────
// TanStack selection is page-scoped; when the whole loaded page is selected but the filter
// matches more, offer to select ALL matching rows (server-side), and to clear that back down.
export function SelectAllBanner({
  pageSelected,
  pageSize,
  total,
  allMatching,
  onSelectAllMatching,
  onClearAllMatching,
  noun = "rows",
}: {
  /** Are all rows on the current page selected? */
  pageSelected: boolean;
  pageSize: number;
  total: number;
  allMatching: boolean;
  onSelectAllMatching: () => void;
  onClearAllMatching: () => void;
  noun?: string;
}) {
  if (allMatching) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-1.5 text-xs">
        <span className="text-foreground">All <span className="font-semibold tabular-nums">{total.toLocaleString()}</span> {noun} matching the filter are selected.</span>
        <button type="button" onClick={onClearAllMatching} className="font-medium text-primary hover:underline">
          Clear selection
        </button>
      </div>
    );
  }
  if (!pageSelected || total <= pageSize) return null;
  return (
    <div className="flex items-center justify-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5 text-xs">
      <span className="text-muted-foreground">All <span className="font-medium tabular-nums text-foreground">{pageSize}</span> on this page are selected.</span>
      <button type="button" onClick={onSelectAllMatching} className="font-medium text-primary hover:underline">
        Select all {total.toLocaleString()} matching
      </button>
    </div>
  );
}
