// A rough, deliberately-approximate "what did that answer cost" estimator.
//
// Public list prices, USD per 1M tokens (input / output). These drift and vary
// by tier — everything here is labelled "est." in the UI. The point is a fun,
// glanceable receipt for the AI's work, not an invoice. The deterministic `rule`
// baseline runs locally and is free → we surface it as "$0 · local".

interface PriceRow {
  /** A short family label for display. */
  id: string;
  /** USD per 1,000,000 input tokens. */
  in: number;
  /** USD per 1,000,000 output tokens. */
  out: number;
  /** Runs locally / no per-token cost. */
  local?: boolean;
  test: (m: string) => boolean;
}

// Order matters: more specific families first (opus/sonnet/haiku are disjoint;
// gpt-4o-mini must beat gpt-4o).
const TABLE: PriceRow[] = [
  { id: "claude-opus-4", in: 15, out: 75, test: (m) => m.includes("opus") },
  { id: "claude-sonnet", in: 3, out: 15, test: (m) => m.includes("sonnet") },
  { id: "claude-haiku", in: 0.8, out: 4, test: (m) => m.includes("haiku") },
  { id: "gpt-4o-mini", in: 0.15, out: 0.6, test: (m) => m.includes("4o-mini") },
  { id: "gpt-4o", in: 2.5, out: 10, test: (m) => m.includes("gpt-4o") || m.includes("4o") },
  { id: "rule", in: 0, out: 0, local: true, test: (m) => m === "rule" || m.startsWith("rule") },
];

function rowFor(model: string | null | undefined): PriceRow | null {
  if (!model) return null;
  const m = model.toLowerCase();
  return TABLE.find((r) => r.test(m)) ?? null;
}

/** True for the deterministic in-process baseline (no per-token cost). */
export function isLocalModel(model: string | null | undefined): boolean {
  return rowFor(model)?.local === true;
}

/**
 * Estimate a completion's USD cost from token counts. Returns:
 *  - `0` for a local/rule model,
 *  - a small positive number for a priced model with token counts,
 *  - `null` when the model is unknown or both token counts are missing.
 */
export function estimateCost(
  model: string | null | undefined,
  tokensIn: number | null | undefined,
  tokensOut: number | null | undefined,
): number | null {
  const row = rowFor(model);
  if (!row) return null;
  if (row.local) return 0;
  if (tokensIn == null && tokensOut == null) return null;
  return ((tokensIn ?? 0) * row.in + (tokensOut ?? 0) * row.out) / 1_000_000;
}

/**
 * Format an estimated cost for a compact monospace readout.
 *  - `null` → "~$?" (unknown model / missing tokens)
 *  - `0`    → "$0"
 *  - big    → "$1.23"
 *  - small  → "$0.0004"
 *  - tiny   → sub-cent, shown in cents: "¢0.04"
 */
export function fmtCost(cost: number | null | undefined): string {
  if (cost == null) return "~$?";
  if (cost === 0) return "$0";
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.01) return `$${cost.toFixed(3)}`;
  if (cost >= 0.0001) return `$${cost.toFixed(4)}`;
  return `¢${(cost * 100).toFixed(3)}`;
}

/** Trim a model id to something readable — drops date/latest/version suffixes. */
export function shortModel(model: string): string {
  return model.replace(/-(\d{6,8}|latest|preview|v\d+)$/i, "");
}
