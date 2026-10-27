// Shared contact primitives — the small types + presentation helpers reused across the contacts
// list, detail, and form surfaces. Extracted from the old routes/contacts.tsx god-file so each
// contact component owns one job and the shared bits live in exactly one place.

export type LoadState = "ok" | "error" | "unavailable";

// The bulk-import textarea seed — shows the accepted row shape at a glance.
export const IMPORT_PLACEHOLDER = `[
  { "email": "ada@acme.com", "name": "Ada Lovelace", "company": "Acme",
    "attributes": { "plan": "Enterprise", "region": "EU" } },
  { "external_id": "usr_42", "name": "Alan Turing", "company": "Acme" }
]`;

// ── status pill for a ticket in the history list ─────────────────────────────
export function ticketStatusVariant(status: string): "default" | "muted" | "outline" {
  const s = status.toLowerCase();
  if (s === "closed" || s === "resolved" || s === "solved") return "muted";
  if (s === "open" || s === "pending") return "default";
  return "outline";
}

// ── attribute editor rows ────────────────────────────────────────────────────
export type AttrRow = { key: string; value: string };

export function attrRowsOf(contact: { attributes?: Record<string, unknown> | null } | null): AttrRow[] {
  const entries = Object.entries(contact?.attributes ?? {});
  const rows = entries.map(([key, value]) => ({ key, value: String(value ?? "") }));
  return rows.length ? rows : [{ key: "", value: "" }];
}

export function rowsToAttributes(rows: AttrRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (k) out[k] = r.value;
  }
  return out;
}

/** Up-to-three attribute chips for the Attributes column; a "+N" tail for the rest. */
export function AttrChips({ attrs }: { attrs: Record<string, string> }) {
  const entries = Object.entries(attrs ?? {});
  if (!entries.length) return <span className="text-muted-foreground">—</span>;
  const shown = entries.slice(0, 3);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map(([k, v]) => (
        <span
          key={k}
          className="inline-flex max-w-[11rem] items-center gap-1 rounded-full border bg-muted/40 px-1.5 py-0.5 text-micro text-muted-foreground"
        >
          <span className="font-medium text-foreground/70">{k}</span>
          <span className="truncate">{String(v)}</span>
        </span>
      ))}
      {entries.length > shown.length && (
        <span className="text-micro text-muted-foreground">+{entries.length - shown.length}</span>
      )}
    </div>
  );
}
