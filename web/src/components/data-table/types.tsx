import type { ReactNode } from "react";

// ── Reusable data-list layer ────────────────────────────────────────────────
// A resource-agnostic table + filter-builder vocabulary. Contacts is the first
// surface; Tickets and other resource views adopt the same DataTable + FilterBar.

export type SortDir = "asc" | "desc";

export interface SortState {
  by: string;
  dir: SortDir;
}

/** One table column. `render` owns the cell so a column can show anything (avatar,
 *  chips, formatted dates); `sortable` wires the header to onSortChange(key). */
export interface DataColumn<T> {
  key: string;
  header: string;
  sortable?: boolean;
  align?: "left" | "right";
  /** Tailwind width/utility classes applied to both the th and the td. */
  cellClassName?: string;
  render: (row: T) => ReactNode;
}

// ── Filter builder ──────────────────────────────────────────────────────────
// Mirror of the API's contact filter grammar (packages/contracts CONTACT_FILTER_OPS).

export type FilterOp =
  | "is"
  | "is_not"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "exists"
  | "not_exists"
  | "before"
  | "after";

export type FilterFieldType = "text" | "date" | "attribute" | "event";

/** A field the filter builder can target. `type` picks the operator set and the value
 *  input; an `attribute`-typed field prompts for a key and resolves to `attr:<key>`;
 *  an `event`-typed field prompts for an event name and resolves to `event:<name>`
 *  (the contact_events timeline — did/didn't do it, or when they last did). */
export interface FilterFieldDef {
  key: string; // core column key, or a marker for the attribute field
  label: string;
  type: FilterFieldType;
  /** Narrow the operator set for this field (defaults to OPS_BY_TYPE[type]) —
   *  also sets the op a fresh condition starts on (the first entry). */
  ops?: FilterOp[];
  /** Per-field op phrasing where the generic labels read wrong — e.g. the
   *  unsubscribed_at timestamp: "Subscription is unsubscribed", not
   *  "Subscription has any value". */
  opLabels?: Partial<Record<FilterOp, string>>;
}

/** A live filter condition. `field` is the RESOLVED target sent to the API: a core
 *  column key (e.g. "company") or "attr:<key>" for an attribute. `id` keys the chip. */
export interface FilterCondition {
  id: string;
  field: string;
  op: FilterOp;
  value?: string;
}

export const OPS_BY_TYPE: Record<FilterFieldType, FilterOp[]> = {
  text: ["is", "is_not", "contains", "not_contains", "starts_with", "ends_with", "exists", "not_exists"],
  date: ["after", "before", "exists", "not_exists"],
  attribute: ["is", "is_not", "contains", "not_contains", "starts_with", "ends_with", "exists", "not_exists"],
  event: ["exists", "not_exists", "after", "before"],
};

/** Op phrasing for `event:<name>` conditions — existence means "did the event",
 *  after/before speak to when it happened. Shared by chips and detail facts. */
export const EVENT_OP_LABEL: Record<string, string> = {
  exists: "has done it",
  not_exists: "has never done it",
  after: "after",
  before: "before",
};

export const OP_LABEL: Record<FilterOp, string> = {
  is: "is",
  is_not: "is not",
  contains: "contains",
  not_contains: "does not contain",
  starts_with: "starts with",
  ends_with: "ends with",
  exists: "has any value",
  not_exists: "is unknown",
  before: "before",
  after: "after",
};

/** Ops that carry no value input (existence checks). */
export const VALUELESS_OPS: ReadonlySet<FilterOp> = new Set<FilterOp>(["exists", "not_exists"]);

/** Human label for a live condition, e.g. `Plan is "Enterprise"` or `Company is set`. */
export function conditionLabel(cond: FilterCondition, fields: FilterFieldDef[]): ReactNode {
  const isAttr = cond.field.startsWith("attr:");
  const isEvent = cond.field.startsWith("event:");
  const def = fields.find((f) => f.key === cond.field);
  const name = isAttr ? cond.field.slice(5) : isEvent ? cond.field.slice(6) : def?.label ?? cond.field;
  const op =
    def?.opLabels?.[cond.op] ?? (isEvent ? EVENT_OP_LABEL[cond.op] : undefined) ?? OP_LABEL[cond.op];
  const val = VALUELESS_OPS.has(cond.op) ? "" : ` “${cond.value ?? ""}”`;
  return (
    <>
      <span className="font-medium text-foreground">{name}</span> <span className="text-muted-foreground">{op}</span>
      {val && <span className="text-foreground">{val}</span>}
    </>
  );
}

// ── OR groups ───────────────────────────────────────────────────────────────
// The builder edits `T[][]`: conditions within a group AND together, groups OR
// together. The API keeps its legacy flat grammar alongside the grouped one,
// so the mapping is shared by every consumer (contacts directory, broadcast
// targeting): a single group ships as the flat list; two or more ship ALL
// rows as groups and leave the flat list empty.

/** Split builder groups into the API's dual grammar. Empty groups are dropped. */
export function splitFilterGroups<T>(groups: T[][]): { flat: T[]; groups?: T[][] } {
  const nonEmpty = groups.filter((g) => g.length > 0);
  if (nonEmpty.length <= 1) return { flat: nonEmpty[0] ?? [] };
  return { flat: [], groups: nonEmpty };
}

/** The inverse — rebuild builder groups from whichever grammar was persisted. */
export function joinFilterGroups<T>(flat: T[] | undefined, groups: T[][] | undefined): T[][] {
  const g = (groups ?? []).filter((x) => x.length > 0);
  if (g.length > 0) return g;
  return [flat ?? []];
}
