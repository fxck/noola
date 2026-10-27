import { useEffect, useMemo, useState } from "react";
import { Bookmark, Check, ChevronDown, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Popover } from "@/components/ui/popover";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { toast } from "@/components/ui/toaster";
import {
  type Segment,
  type SegmentDefinition,
  fetchSegments,
  createSegment,
  updateSegment,
  deleteSegment,
} from "@/lib/segments";

// ── Saved Segments ─────────────────────────────────────────────────────────────
// A named, reusable filter over the contacts directory. The bar owns the segment CRUD and
// the "which segment is applied + has it drifted" state; the parent owns the live filters and
// re-applies a chosen `definition` via `onApply`. Segments persist the exact grammar the
// /contacts query params accept (q + filters + sort), so applying one is a straight lift.

const DEFAULT_SORT = { sortBy: "updated_at", sortDir: "desc" as const };

/** Canonical, comparable form — coalesces every "unset" so a freshly re-applied segment
 *  reads as identical (not "modified") to what the page is actually showing. */
function normDef(d: SegmentDefinition): string {
  return JSON.stringify({
    q: (d.q ?? "").trim(),
    filters: (d.filters ?? []).map((f) => ({ field: f.field, op: f.op, value: f.value ?? "" })),
    sortBy: d.sortBy || "",
    sortDir: d.sortDir || "",
  });
}

/** Persistable shape — drop empty q/sort, omit absent filter values. */
function cleanDef(d: SegmentDefinition): SegmentDefinition {
  return {
    q: d.q?.trim() || undefined,
    filters: (d.filters ?? []).map((f) => ({
      field: f.field,
      op: f.op,
      ...(f.value !== undefined ? { value: f.value } : {}),
    })),
    sortBy: d.sortBy || undefined,
    sortDir: d.sortDir || undefined,
  };
}

/** Is there enough of a view to be worth naming and saving? */
function hasSubstance(d: SegmentDefinition): boolean {
  return !!(d.q?.trim() || (d.filters && d.filters.length));
}

const byName = (a: Segment, b: Segment) => a.name.localeCompare(b.name);

type Applied = { id: string; name: string; def: SegmentDefinition };

export function SegmentBar({
  resource = "contacts",
  definition,
  onApply,
  className,
}: {
  /** Which collection these saved views belong to (contacts | tickets | broadcasts | reports …).
   *  The segments store is already resource-scoped; this makes ONE switcher drive any surface. */
  resource?: string;
  /** The live view (q + active filters + sort) the page is currently showing. */
  definition: SegmentDefinition;
  /** Apply a segment's definition to the page (sets q + filters + sort, reflects to URL, refetches). */
  onApply: (def: SegmentDefinition) => void;
  className?: string;
}) {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [applied, setApplied] = useState<Applied | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const list = await fetchSegments(resource);
        if (live) setSegments([...list].sort(byName));
      } catch {
        /* segments are optional chrome — a load failure just leaves the picker empty */
      }
    })();
    return () => {
      live = false;
    };
  }, [resource]);

  const modified = applied ? normDef(definition) !== normDef(applied.def) : false;
  const canSave = hasSubstance(definition);

  function applySegment(seg: Segment) {
    const resolved: SegmentDefinition = {
      q: seg.definition.q ?? "",
      filters: seg.definition.filters ?? [],
      sortBy: seg.definition.sortBy ?? DEFAULT_SORT.sortBy,
      sortDir: seg.definition.sortDir ?? DEFAULT_SORT.sortDir,
    };
    onApply(resolved);
    setApplied({ id: seg.id, name: seg.name, def: resolved });
    setPickerOpen(false);
  }

  function revert() {
    if (applied) onApply(applied.def);
  }

  async function create(name: string) {
    const def = cleanDef(definition);
    try {
      const seg = await createSegment({ name, resource, definition: def });
      setSegments((prev) => [...prev, seg].sort(byName));
      setApplied({ id: seg.id, name: seg.name, def });
      toast.success(`Saved segment “${seg.name}”.`);
    } catch {
      toast.error("Couldn't save segment. Please try again.");
    }
  }

  async function saveOver() {
    if (!applied) return;
    const def = cleanDef(definition);
    try {
      const seg = await updateSegment(applied.id, { definition: def });
      setSegments((prev) => prev.map((s) => (s.id === seg.id ? seg : s)).sort(byName));
      setApplied({ id: seg.id, name: seg.name, def });
      toast.success(`Updated “${seg.name}”.`);
    } catch {
      toast.error("Couldn't update segment. Please try again.");
    }
  }

  async function rename(id: string, name: string) {
    try {
      const seg = await updateSegment(id, { name });
      setSegments((prev) => prev.map((s) => (s.id === seg.id ? seg : s)).sort(byName));
      setApplied((a) => (a && a.id === id ? { ...a, name: seg.name } : a));
      toast.success("Segment renamed.");
    } catch {
      toast.error("Couldn't rename segment. Please try again.");
    }
  }

  async function remove(id: string) {
    setConfirmId(null);
    try {
      await deleteSegment(id);
      setSegments((prev) => prev.filter((s) => s.id !== id));
      setApplied((a) => (a && a.id === id ? null : a));
      toast.success("Segment deleted.");
    } catch {
      toast.error("Couldn't delete segment. Please try again.");
    }
  }

  const confirmTarget = segments.find((s) => s.id === confirmId) ?? null;

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      <Popover
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        width={264}
        trigger={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 max-w-[14rem] gap-1.5 px-2 text-xs"
            onClick={() => setPickerOpen((o) => !o)}
          >
            <Bookmark className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{applied ? applied.name : "Segments"}</span>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          </Button>
        }
      >
        <SegmentList
          segments={segments}
          appliedId={applied?.id ?? null}
          onApply={applySegment}
          onRename={rename}
          onDelete={(id) => setConfirmId(id)}
        />
      </Popover>

      {applied && (
        <span className="inline-flex items-center gap-1.5">
          {modified && (
            <>
              <Badge variant="warning" className="gap-1">
                <span className="size-1.5 rounded-full bg-warning" /> Modified
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => void saveOver()}
              >
                Update segment
              </Button>
              <SaveForm label="Save as new" onSave={create} />
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground"
                onClick={revert}
              >
                Reset
              </Button>
            </>
          )}
          <button
            type="button"
            aria-label="Clear applied segment"
            onClick={() => setApplied(null)}
            className="grid size-5 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </span>
      )}

      {!applied && canSave && <SaveForm label="Save as segment" variant="outline" onSave={create} />}

      <ConfirmDialog
        open={confirmId !== null}
        title={`Delete segment${confirmTarget ? ` “${confirmTarget.name}”` : ""}?`}
        message="This removes the saved view. Your current filters stay applied."
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          if (confirmId) void remove(confirmId);
        }}
        onCancel={() => setConfirmId(null)}
      />
    </div>
  );
}

/** The picker: apply a saved segment, or rename / delete one inline. */
function SegmentList({
  segments,
  appliedId,
  onApply,
  onRename,
  onDelete,
}: {
  segments: Segment[];
  appliedId: string | null;
  onApply: (seg: Segment) => void;
  onRename: (id: string, name: string) => void | Promise<void>;
  onDelete: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return segments;
    return segments.filter((s) => s.name.toLowerCase().includes(q));
  }, [segments, query]);

  function startRename(seg: Segment) {
    setRenamingId(seg.id);
    setDraft(seg.name);
  }
  function commitRename() {
    if (renamingId) {
      const name = draft.trim();
      if (name) void onRename(renamingId, name);
    }
    setRenamingId(null);
  }

  return (
    <div className="flex max-h-96 w-full flex-col">
      {segments.length > 6 && (
        <div className="flex items-center gap-2 border-b px-2.5">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a segment…"
            className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            aria-label="Find a segment"
          />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {filtered.length === 0 ? (
          <div className="px-2 py-6 text-center text-xs text-muted-foreground">
            {segments.length === 0 ? "No saved segments yet." : "No segments match."}
          </div>
        ) : (
          filtered.map((seg) => {
            if (renamingId === seg.id) {
              return (
                <div key={seg.id} className="flex items-center gap-1.5 px-1 py-1">
                  <Input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitRename();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setRenamingId(null);
                      }
                    }}
                    className="h-7 text-sm"
                  />
                  <Button
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={commitRename}
                    disabled={!draft.trim()}
                  >
                    Save
                  </Button>
                </div>
              );
            }
            const isApplied = seg.id === appliedId;
            return (
              <div
                key={seg.id}
                className="group/seg flex items-center gap-1 rounded-md px-1 transition-colors hover:bg-accent"
              >
                <button
                  type="button"
                  onClick={() => onApply(seg)}
                  className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-1 text-left text-sm"
                >
                  <Check
                    className={cn("size-4 shrink-0", isApplied ? "text-primary opacity-100" : "opacity-0")}
                  />
                  <span className="truncate">{seg.name}</span>
                </button>
                <button
                  type="button"
                  aria-label={`Rename ${seg.name}`}
                  onClick={() => startRename(seg)}
                  className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/seg:opacity-100"
                >
                  <Pencil className="size-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${seg.name}`}
                  onClick={() => onDelete(seg.id)}
                  className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-destructive focus-visible:opacity-100 group-hover/seg:opacity-100"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/** A small name-and-save popover — no `window.prompt`. Used for "Save as segment" and "Save as new". */
function SaveForm({
  label,
  variant = "ghost",
  onSave,
}: {
  label: string;
  variant?: "ghost" | "outline";
  onSave: (name: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await onSave(trimmed);
      setName("");
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setName("");
      }}
      width={244}
      trigger={
        <Button
          type="button"
          variant={variant}
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={() => setOpen((o) => !o)}
        >
          <Plus className="size-3.5" /> {label}
        </Button>
      }
    >
      <div className="p-2.5">
        <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Segment name</label>
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="e.g. Enterprise · US"
          className="h-8 text-sm"
        />
        <div className="mt-2 flex justify-end gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setOpen(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => void submit()}
            disabled={!name.trim() || busy}
          >
            Save
          </Button>
        </div>
      </div>
    </Popover>
  );
}
