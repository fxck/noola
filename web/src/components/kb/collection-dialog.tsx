import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  type KbCollection,
  createCollection,
  updateCollection,
} from "@/lib/kb";
import { COLLECTION_COLORS, DEFAULT_COLLECTION_COLOR } from "./collection-common";

/**
 * Create / rename a KB collection. A center scale-in modal built on the shared
 * `.motion-overlay` / `.motion-pop` classes (reduced-motion safe), mirroring
 * ConfirmDialog. Owns the create/update call and reports the saved row to `onSaved`.
 * `initial === null` → create; otherwise edit that collection.
 */
export function CollectionDialog({
  open,
  initial,
  nextPosition,
  onClose,
  onSaved,
}: {
  open: boolean;
  initial: KbCollection | null;
  /** Position to assign a newly created collection (append to the end). */
  nextPosition?: number;
  onClose: () => void;
  onSaved: (collection: KbCollection) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState<string>(DEFAULT_COLLECTION_COLOR);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the form whenever the dialog (re)opens or the target collection changes.
  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? "");
    setDescription(initial?.description ?? "");
    setColor(initial?.color || DEFAULT_COLLECTION_COLOR);
    setError(null);
    setSaving(false);
  }, [open, initial]);

  // Escape closes (unless mid-save), matching the app's popovers/dialogs.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, saving, onClose]);

  if (!open) return null;

  async function save() {
    const n = name.trim();
    if (!n) return;
    setSaving(true);
    setError(null);
    try {
      const patch = { name: n, description: description.trim(), color };
      const saved = initial
        ? await updateCollection(initial.id, patch)
        : await createCollection({ ...patch, position: nextPosition });
      onSaved(saved);
    } catch {
      setError(
        initial
          ? "Couldn't save the collection. Please try again."
          : "Couldn't create the collection. Please try again.",
      );
      setSaving(false);
    }
  }

  return (
    <div
      className="motion-overlay fixed inset-0 z-[60] grid place-items-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={initial ? "Rename collection" : "New collection"}
      onClick={() => !saving && onClose()}
    >
      <div
        className="motion-pop w-full max-w-md rounded-xl border bg-card p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-semibold">
          {initial ? "Rename collection" : "New collection"}
        </h2>

        <div className="mt-4 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="collection-name" className="text-xs font-medium text-muted-foreground">
              Name
            </label>
            <Input
              id="collection-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void save();
                }
              }}
              placeholder="e.g. Billing & invoices"
              aria-label="Collection name"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Color</span>
            <div className="flex flex-wrap gap-2">
              {COLLECTION_COLORS.map((c) => {
                const on = color.toLowerCase() === c.toLowerCase();
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    aria-label={`Use color ${c}`}
                    aria-pressed={on}
                    className={cn(
                      "size-6 rounded-full ring-offset-2 ring-offset-card transition-transform duration-150 ease-[var(--ease-out-strong)] hover:scale-110 active:scale-90 motion-reduce:transition-none motion-reduce:hover:scale-100",
                      on && "ring-2 ring-ring",
                    )}
                    style={{ backgroundColor: c }}
                  />
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="collection-description"
              className="text-xs font-medium text-muted-foreground"
            >
              Description <span className="text-muted-foreground/60">(optional)</span>
            </label>
            <Input
              id="collection-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void save();
                }
              }}
              placeholder="What belongs in here?"
              aria-label="Collection description"
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={saving || !name.trim()}>
            {saving ? "Saving…" : initial ? "Save changes" : "Create collection"}
          </Button>
        </div>
      </div>
    </div>
  );
}
