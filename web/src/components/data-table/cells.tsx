import { type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Check, Minus } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { relativeTime } from "@/lib/tickets";
import { avatarSrc } from "@/lib/avatar-upload";

/** The table's row/header selection checkbox — a themed button (not the form `ui/checkbox`):
 *  supports an indeterminate ("mixed") state for header select-all, and stops propagation so a
 *  click selects the row without also opening it. */
export function Checkbox({
  checked,
  indeterminate,
  onChange,
  label,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        checked || indeterminate
          ? "border-primary bg-primary text-primary-foreground"
          : "border-input bg-background hover:border-primary/50",
      )}
    >
      {indeterminate ? <Minus className="size-3" /> : checked ? <Check className="size-3" /> : null}
    </button>
  );
}

// ── The cell-kind library ────────────────────────────────────────────────────
// One shared vocabulary of table cells so every collection surface renders the same
// entity / state / metric / date / tags language instead of hand-rolling each. These are
// the atoms the ONE table system is built from (UX diagnosis §4a). All are presentational:
// a cell receives values, not fetchers, and never re-fetches — what's on the row is a
// column-definition decision (Theme 2).

/** Small number formats shared by the metric cells. `nfmt` matches Intercom's "2,808". */
export const nfmt = (n: number) => n.toLocaleString();
export const pctfmt = (n: number) => `${Math.round(n)}%`;

// ── EntityCell — avatar + name (+ optional sub-line); explicit ghost "Unassigned" ──
// Replaces bare 16px avatars and plain-text agent names across tickets/inbox/csat/members.
export function EntityCell({
  name,
  image,
  sub,
  to,
  params,
  size = "sm",
  className,
}: {
  name?: string | null;
  /** Raw avatar URL (resolved through avatarSrc); omit for initials. */
  image?: string | null;
  /** Optional muted second line (email, company, role…). */
  sub?: ReactNode;
  /** Optional route to open on click (stops row-click propagation). */
  to?: string;
  params?: Record<string, string>;
  size?: "sm" | "md";
  className?: string;
}) {
  const empty = !name || !name.trim();
  const av = empty ? (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded-full border border-dashed border-border text-muted-foreground",
        size === "sm" ? "size-5" : "size-6",
      )}
    />
  ) : (
    <Avatar name={name} image={avatarSrc(image)} className={cn(size === "sm" ? "size-5 text-[9px]" : "size-6 text-micro")} />
  );
  const body = (
    <span className="flex min-w-0 flex-col leading-tight">
      <span className={cn("truncate", empty ? "text-muted-foreground" : "font-medium text-foreground")}>
        {empty ? "Unassigned" : name}
      </span>
      {sub != null && sub !== "" && <span className="truncate text-xs text-muted-foreground">{sub}</span>}
    </span>
  );
  const inner = (
    <span className={cn("flex min-w-0 items-center gap-2", className)}>
      {av}
      {body}
    </span>
  );
  if (to && !empty) {
    return (
      <Link
        to={to as never}
        params={params as never}
        onClick={(e) => e.stopPropagation()}
        className="inline-flex min-w-0 max-w-full rounded hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {inner}
      </Link>
    );
  }
  return inner;
}

// ── StatePill — one pill taxonomy across every resource's lifecycle state ─────
// A tone maps to a Badge variant; a leading dot makes state scannable at a glance. Replaces
// 5-tab / band-tab / status-dot / inline-Switch idioms on the TABLE surfaces (inbox keeps its
// pill-free queue, STRUCTURE.md §4).
export type PillTone = "neutral" | "success" | "warning" | "danger" | "info" | "draft";
const TONE_VARIANT: Record<PillTone, "muted" | "success" | "warning" | "destructive" | "default" | "outline"> = {
  neutral: "muted",
  success: "success",
  warning: "warning",
  danger: "destructive",
  info: "default",
  draft: "outline",
};
const TONE_DOT: Record<PillTone, string> = {
  neutral: "bg-muted-foreground/60",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
  info: "bg-primary",
  draft: "bg-muted-foreground/50",
};

export function StatePill({ label, tone = "neutral", dot = true, className }: { label: string; tone?: PillTone; dot?: boolean; className?: string }) {
  return (
    <Badge variant={TONE_VARIANT[tone]} className={cn("gap-1.5 font-medium capitalize", className)}>
      {dot && <span className={cn("size-1.5 rounded-full", TONE_DOT[tone])} />}
      {label}
    </Badge>
  );
}

// ── MetricDrillCell — a count that drills to a filtered child list (Theme 3) ──
// Intercom's "Sent 2,808 →": a number rendered as a link to a target collection with a
// pre-applied filter. Inert (muted) when there's no target or the value is zero — a drill only
// lights up once the target actually accepts the filter as a query-param.
export function MetricDrillCell({
  value,
  to,
  params,
  search,
  format = nfmt,
  align = "right",
  emphasize,
}: {
  value: number | null | undefined;
  to?: string;
  params?: Record<string, string>;
  search?: Record<string, unknown>;
  format?: (n: number) => string;
  align?: "left" | "right";
  /** Render non-zero value in foreground weight even when not a link. */
  emphasize?: boolean;
}) {
  const n = value ?? 0;
  const cls = cn("tabular-nums", align === "right" ? "text-right" : "text-left");
  if (!to || n === 0) {
    return <span className={cn(cls, n === 0 ? "text-muted-foreground" : emphasize ? "font-medium text-foreground" : "text-foreground")}>{n === 0 ? "—" : format(n)}</span>;
  }
  return (
    <Link
      to={to as never}
      params={params as never}
      search={search as never}
      onClick={(e) => e.stopPropagation()}
      className={cn(cls, "font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded")}
    >
      {format(n)}
    </Link>
  );
}

// ── DateCell — relative label, absolute timestamp on hover; em-dash when null ──
export function DateCell({ iso, className }: { iso?: string | null; className?: string }) {
  if (!iso) return <span className={cn("text-muted-foreground", className)}>—</span>;
  const d = new Date(iso);
  return (
    <span className={cn("tabular-nums text-muted-foreground", className)} title={d.toLocaleString()}>
      {relativeTime(iso)}
    </span>
  );
}

// ── TagsCell — chip row for string[] (tickets.tags exists but is never shown) ─
export function TagsCell({ tags, max = 3, className }: { tags?: string[] | null; max?: number; className?: string }) {
  if (!tags || tags.length === 0) return <span className={cn("text-muted-foreground", className)}>—</span>;
  const shown = tags.slice(0, max);
  const extra = tags.length - shown.length;
  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {shown.map((t) => (
        <Badge key={t} variant="muted" className="max-w-[10rem] truncate px-1.5 py-0 text-micro font-normal">
          {t}
        </Badge>
      ))}
      {extra > 0 && <span className="text-xs text-muted-foreground">+{extra}</span>}
    </div>
  );
}
