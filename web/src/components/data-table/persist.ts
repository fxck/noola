import { useEffect, useState } from "react";
import type { VisibilityState } from "@tanstack/react-table";

// Persist a table's chosen columns across reloads/navigation (Intercom remembers your layout).
// Keyed per table in localStorage; the caller's `initial` supplies the defaults for any column the
// stored map doesn't mention (so newly-added columns still honour their default visibility).

export function usePersistentVisibility(storageKey: string, initial: VisibilityState) {
  const [state, setState] = useState<VisibilityState>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) return { ...initial, ...(JSON.parse(raw) as VisibilityState) };
    } catch {
      /* corrupt/absent storage — fall back to defaults */
    }
    return initial;
  });
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      /* storage full / unavailable — visibility just won't persist */
    }
  }, [storageKey, state]);
  return [state, setState] as const;
}

/** Persist a rows-per-page choice, validated against the allowed set (an out-of-range stored value
 *  falls back to `initial` rather than trusting arbitrary localStorage). */
export function usePersistentNumber(storageKey: string, initial: number, allowed: readonly number[]) {
  const [state, setState] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw != null) {
        const n = Number(raw);
        if (allowed.includes(n)) return n;
      }
    } catch {
      /* ignore */
    }
    return initial;
  });
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, String(state));
    } catch {
      /* ignore */
    }
  }, [storageKey, state]);
  return [state, setState] as const;
}
