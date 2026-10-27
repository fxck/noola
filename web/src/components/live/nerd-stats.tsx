import { useState, type ReactNode } from "react";
import { Check, Copy, Terminal, X } from "lucide-react";
import { cn } from "@/lib/utils";

// ── formatters ──────────────────────────────────────────────────────────────

/** 1234 → "1.2k", 512 → "512". */
export function compactNum(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Token counts as "1.2k tok" / "312 tok"; null → "—". */
export function fmtTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${compactNum(n)} tok`;
}

/** Latency as "312ms" / "1.2s"; null → "—". */
export function fmtMs(n: number | null | undefined): string {
  if (n == null) return "—";
  return n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(2)}s`;
}

/** 0..1 score → "0.82"; null → "—". */
export function fmtScore(n: number | null | undefined): string {
  return n == null ? "—" : n.toFixed(2);
}

// ── building blocks ─────────────────────────────────────────────────────────

export interface StatRow {
  label: string;
  value: ReactNode;
  title?: string;
}

/** A labelled metric line inside a NerdStats panel. */
export function Stat({ label, value, title }: StatRow) {
  return (
    <div className="flex items-baseline justify-between gap-3" title={title}>
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-foreground">{value}</span>
    </div>
  );
}

/** A 0..1 score rendered as a thin filled bar with the numeric value. */
export function ScoreBar({ score, label }: { score: number; label?: string }) {
  const pct = Math.max(0, Math.min(1, score)) * 100;
  return (
    <div className="flex items-center gap-2">
      {label && <span className="w-14 shrink-0 truncate text-muted-foreground">{label}</span>}
      <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-primary/70"
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="w-8 shrink-0 text-right tabular-nums text-muted-foreground">
        {score.toFixed(2)}
      </span>
    </div>
  );
}

/** A monospace token/id with a click-to-copy affordance. */
export function CopyId({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => {},
        );
      }}
      title={`Copy ${value}`}
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded hover:text-foreground",
        className,
      )}
    >
      <span className="truncate">{value}</span>
      {copied ? (
        <Check className="size-3 shrink-0 text-success" />
      ) : (
        <Copy className="size-3 shrink-0 opacity-60" />
      )}
    </button>
  );
}

// ── panel ───────────────────────────────────────────────────────────────────

/**
 * The reusable instrument panel. Monospace, muted, compact, dismissible —
 * deliberately reads as "debug readout", never competing with the primary flow.
 * Only mount it when nerd mode is on (callers gate). Respects reduced-motion.
 */
export function NerdStats({
  title = "nerd stats",
  rows,
  onDismiss,
  className,
  children,
}: {
  title?: string;
  rows?: StatRow[];
  onDismiss?: () => void;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "nerd-in rounded-lg border border-dashed border-border bg-muted/30 p-2.5 font-mono text-micro leading-relaxed",
        className,
      )}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 uppercase tracking-wide text-muted-foreground/80">
          <Terminal className="size-3" />
          {title}
        </span>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Hide stats"
            className="text-muted-foreground/60 hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        )}
      </div>
      <div className="space-y-1">
        {rows?.map((r) => <Stat key={r.label} {...r} />)}
        {children}
      </div>
    </div>
  );
}
