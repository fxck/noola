import { useEffect, useRef, useState } from "react";
import type { ColumnDef, OnChangeFn, VisibilityState } from "@tanstack/react-table";

// ── Intercom-style attribute columns ─────────────────────────────────────────
// Imported contacts/companies carry an open bag of `attributes` (the columns Intercom exported:
// OS, City, Web sessions, Last contacted…). Rather than hard-code six columns, we surface EVERY
// imported attribute as an optional, default-hidden column — the "add columns" affordance from
// Intercom's list view. Keys keep their original export names, so the labels read the same.

type WithAttrs = { attributes?: Record<string, unknown> | null };

/** Session-accumulated set of attribute keys seen across fetched pages (never shrinks within a
 *  session), so the column picker can offer every imported attribute even though each page only
 *  carries the rows currently in view. */
export function useAttributeKeys<T extends WithAttrs>(rows: T[]): string[] {
  const [keys, setKeys] = useState<string[]>([]);
  useEffect(() => {
    setKeys((prev) => {
      const set = new Set(prev);
      let changed = false;
      for (const r of rows) {
        for (const k of Object.keys(r.attributes ?? {})) {
          if (!set.has(k)) {
            set.add(k);
            changed = true;
          }
        }
      }
      return changed ? [...set].sort((a, b) => a.localeCompare(b)) : prev;
    });
  }, [rows]);
  return keys;
}

const ATTR_PREFIX = "attr:";
export const attrColumnId = (key: string) => `${ATTR_PREFIX}${key}`;

// Attribute values arrive as strings from the importer, but stay defensive for API-set values.
function formatAttrValue(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return v.length ? v.map((x) => String(x)).join(", ") : "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** One optional column per imported attribute key. Display-only — arbitrary attributes aren't
 *  server-sortable, so these don't offer sort. Hidden by default via `useHideAttrsByDefault`. */
export function attributeColumns<T extends WithAttrs>(keys: string[]): ColumnDef<T, unknown>[] {
  return keys.map((key) => ({
    id: attrColumnId(key),
    accessorFn: (row: T) => (row.attributes ?? {})[key],
    header: key,
    enableSorting: false,
    meta: { label: key },
    cell: ({ getValue }) => {
      const s = formatAttrValue(getValue());
      return s ? (
        <span className="block max-w-[18rem] truncate whitespace-nowrap text-muted-foreground" title={s}>
          {s}
        </span>
      ) : null;
    },
  }));
}

/** Keep newly-discovered attribute columns hidden by default, without clobbering a toggle the user
 *  has already made (only sets visibility for ids not yet seen). */
export function useHideAttrsByDefault(attrKeys: string[], setVisibility: OnChangeFn<VisibilityState>) {
  const applied = useRef<Set<string>>(new Set());
  useEffect(() => {
    const fresh = attrKeys.map(attrColumnId).filter((id) => !applied.current.has(id));
    if (!fresh.length) return;
    fresh.forEach((id) => applied.current.add(id));
    setVisibility((v) => {
      const next = { ...v };
      for (const id of fresh) if (next[id] === undefined) next[id] = false;
      return next;
    });
  }, [attrKeys, setVisibility]);
}
