import { useEffect, useState } from "react";
import { Loader2, Plus, Trash2, Pencil, Check, X } from "lucide-react";
import { toast } from "@/components/ui/toaster";
import {
  type TicketType,
  type TypeColor,
  TYPE_COLORS,
  typeChipClass,
  typeDotClass,
  fetchTicketTypes,
  createTicketType,
  updateTicketType,
  deleteTicketType,
} from "@/lib/ticket-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingsPage } from "@/components/settings-page";
import { cn } from "@/lib/utils";

type Status = "loading" | "ready" | "error";
type Editing = { id: string; name: string; color: TypeColor };

export function SettingsTicketTypesPage() {
  const [status, setStatus] = useState<Status>("loading");
  const [types, setTypes] = useState<TicketType[]>([]);
  const [name, setName] = useState("");
  const [color, setColor] = useState<TypeColor>("slate");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  function load() {
    setStatus("loading");
    fetchTicketTypes()
      .then((t) => {
        setTypes(t);
        setStatus("ready");
      })
      .catch(() => setStatus("error"));
  }
  useEffect(load, []);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    try {
      const type = await createTicketType({ name: trimmed, color });
      setTypes((t) => [...t, type]);
      setName("");
      setColor("slate");
      toast.success(`Added “${type.name}”.`);
    } catch (e) {
      toast.error(e instanceof Error && /409|exists/i.test(e.message) ? "A type with that name already exists." : "Couldn't add the type.");
    } finally {
      setCreating(false);
    }
  }

  // Inline rename/recolor in place (D9). The id stays stable, so every ticket already
  // typed keeps pointing at the same type — a rename never orphans existing references.
  async function saveEdit() {
    if (!editing) return;
    const trimmed = editing.name.trim();
    if (!trimmed) return;
    const { id, color: nextColor } = editing;
    setSavingEdit(true);
    try {
      const updated = await updateTicketType(id, { name: trimmed, color: nextColor });
      setTypes((t) => t.map((x) => (x.id === id ? updated : x)));
      setEditing(null);
    } catch (e) {
      toast.error(
        e instanceof Error && /409|exists/i.test(e.message)
          ? "A type with that name already exists."
          : "Couldn't save the type.",
      );
    } finally {
      setSavingEdit(false);
    }
  }

  async function remove(type: TicketType) {
    if (editing?.id === type.id) setEditing(null);
    setTypes((t) => t.filter((x) => x.id !== type.id)); // optimistic
    try {
      await deleteTicketType(type.id);
    } catch {
      toast.error("Couldn't delete the type.");
      load();
    }
  }

  return (
    <SettingsPage
      active="ticket-types"
      title="Ticket types"
      description="A taxonomy for your tickets — distinct from priority (urgency) and tags (freeform)."
      status={status}
      onRetry={load}
      errorTitle="Couldn't load your ticket types"
    >
            <div className="max-w-2xl px-6 pb-10 pt-4">
              <div className="mb-6 overflow-hidden rounded-xl border bg-card shadow-sm">
                {types.length === 0 ? (
                  <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                    No ticket types yet. Add your first below.
                  </p>
                ) : (
                  <ul className="divide-y">
                    {types.map((t) =>
                      editing?.id === t.id ? (
                        <li key={t.id} className="space-y-2.5 px-4 py-3">
                          <div className="flex items-center gap-2">
                            <Input
                              value={editing.name}
                              autoFocus
                              className="h-8"
                              onChange={(e) => setEditing((s) => (s ? { ...s, name: e.target.value } : s))}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void saveEdit();
                                if (e.key === "Escape") setEditing(null);
                              }}
                            />
                            <Button size="icon" className="size-8 shrink-0" disabled={savingEdit || !editing.name.trim()} onClick={() => void saveEdit()} title="Save" aria-label="Save">
                              {savingEdit ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <Check />}
                            </Button>
                            <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={() => setEditing(null)} title="Cancel" aria-label="Cancel">
                              <X />
                            </Button>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {TYPE_COLORS.map((c) => (
                              <button
                                key={c}
                                type="button"
                                onClick={() => setEditing((s) => (s ? { ...s, color: c } : s))}
                                aria-label={c}
                                aria-pressed={editing.color === c}
                                className={cn(
                                  "rounded-full border px-2.5 py-1 text-xs font-medium capitalize transition-[opacity,box-shadow] duration-150 ease-out",
                                  typeChipClass(c),
                                  editing.color === c ? "ring-1 ring-current/30" : "opacity-70 hover:opacity-100",
                                )}
                              >
                                {c}
                              </button>
                            ))}
                          </div>
                        </li>
                      ) : (
                        <li key={t.id} className="flex items-center gap-3 px-4 py-3">
                          <span className={cn("size-2 shrink-0 rounded-full", typeDotClass(t.color))} aria-hidden />
                          <span className="truncate text-sm font-medium">{t.name}</span>
                          <span className="ml-auto text-xs capitalize text-muted-foreground">{t.color}</span>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            onClick={() => setEditing({ id: t.id, name: t.name, color: (t.color as TypeColor) ?? "slate" })}
                            title="Rename or recolor"
                            aria-label={`Edit ${t.name}`}
                          >
                            <Pencil className="text-muted-foreground" />
                          </Button>
                          <Button variant="ghost" size="icon" className="size-8" onClick={() => void remove(t)} title="Delete type" aria-label={`Delete ${t.name}`}>
                            <Trash2 className="text-muted-foreground" />
                          </Button>
                        </li>
                      ),
                    )}
                  </ul>
                )}
              </div>

              <div className="space-y-4 rounded-xl border bg-card p-6 shadow-sm">
                <h2 className="text-sm font-semibold">Add a type</h2>
                <div className="space-y-1.5">
                  <Label htmlFor="tt-name">Name</Label>
                  <Input id="tt-name" value={name} placeholder="e.g. Bug report"
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void create(); }} />
                </div>
                <div className="space-y-1.5">
                  <Label>Color</Label>
                  <div className="flex flex-wrap gap-2">
                    {TYPE_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setColor(c)}
                        aria-label={c}
                        aria-pressed={color === c}
                        className={cn(
                          "rounded-full border px-2.5 py-1 text-xs font-medium capitalize transition-[opacity,box-shadow] duration-150 ease-out",
                          typeChipClass(c),
                          color === c ? "ring-1 ring-current/30" : "opacity-70 hover:opacity-100",
                        )}
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                </div>
                <Button onClick={() => void create()} disabled={creating || !name.trim()}>
                  {creating ? <><Loader2 className="animate-spin motion-reduce:animate-none" /> Adding…</> : <><Plus /> Add type</>}
                </Button>
              </div>
            </div>
    </SettingsPage>
  );
}
