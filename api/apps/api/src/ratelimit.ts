// In-memory fixed-window rate limiter. Per-process — correct for the current single-container
// dev/stage topology; a Valkey-backed shared limiter is the documented upgrade for prod HA.
type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

export interface RateResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSec: number;
}

/** Count one hit for `key` in the current window; report whether it stays under `limit`. */
export function rateLimit(key: string, limit: number, windowMs: number): RateResult {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count++;
  return {
    allowed: b.count <= limit,
    limit,
    remaining: Math.max(0, limit - b.count),
    resetSec: Math.max(0, Math.ceil((b.resetAt - now) / 1000)),
  };
}

// Sweep expired buckets so the map can't grow unbounded. unref() so it never keeps the
// process alive on its own.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}, 60_000);
sweep.unref?.();
