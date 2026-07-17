import { useEffect, useState } from "react";
import { Loader2, Plus, Trash2, X, Pencil, Check } from "lucide-react";
import { toast } from "@/components/ui/toaster";
import {
  type CustomFieldDef,
  type CustomFieldType,
  CUSTOM_FIELD_TYPES,
  fetchFieldDefs,
  createFieldDef,
  updateFieldDef,
  deleteFieldDef,
} from "@/lib/custom-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PopoverSelect } from "@/components/ui/menu";
import { Label } from "@/components/ui/label";
import { SettingsPage } from "@/components/settings-page";

type Status = "loading" | "ready" | "error";
type EditState = { id: string; label: string; fieldType: CustomFieldType; options: string[]; optionDraft: string };

// Input-mirroring trigger for PopoverSelect in settings forms (matches ui/input.tsx).
const SELECT_TRIGGER =
  "my-0 h-9 w-full justify-between rounded-md border border-input bg-background px-3 py-1 text-sm font-normal shadow-sm hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed";

const TYPE_LABEL: Record<CustomFieldType, string> = {
  text: "Text",
  number: "Number",
  select: "Select",
  boolean: "Checkbox",
  date: "Date",
};

export function SettingsCustomFieldsPage() {
  const [status, setStatus] = useState<Status>("loading");
  const [fields, setFields] = useState<CustomFieldDef[]>([]);

  // New-field form
  const [label, setLabel] = useState("");
  const [fieldType, setFieldType] = useState<CustomFieldType>("text");
  const [entity, setEntity] = useState<"ticket" | "company">("ticket");
  const [options, setOptions] = useState<string[]>([]);
  const [optionDraft, setOptionDraft] = useState("");
  const [creating, setCreating] = useState(false);

  // Inline edit-in-place
  const [editing, setEditing] = useState<EditState | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  function load() {
    setStatus("loading");
    fetchFieldDefs()
      .then((f) => {
        setFields(f);
        setStatus("ready");
      })
      .catch(() => setStatus("error"));
  }
  useEffect(load, []);

  function addOption() {
    const v = optionDraft.trim();
    if (!v || options.includes(v)) return;
    setOptions((o) => [...o, v]);
    setOptionDraft("");
  }

  async function create() {
    const trimmed = label.trim();
    if (!trimmed) return;
    if (fieldType === "select" && options.length === 0) {
      toast.error("Add at least one option for a select field.");
      return;
    }
    setCreating(true);
    try {
      const field = await createFieldDef({
        entity,
        label: trimmed,
        fieldType,
        options: fieldType === "select" ? options : undefined,
      });
      setFields((f) => [...f, field]);
      setLabel("");
      setFieldType("text");
      setOptions([]);
      setOptionDraft("");
      toast.success(`Added “${field.label}”.`);
    } catch (e) {
      toast.error(e instanceof Error && /409|exists/i.test(e.message) ? "A field with that key already exists." : "Couldn't add the field.");
    } finally {
      setCreating(false);
    }
  }

  function startEdit(field: CustomFieldDef) {
    setEditing({
      id: field.id,
      label: field.label,
      fieldType: field.field_type,
      options: [...field.options],
      optionDraft: "",
    });
  }

  function addEditOption() {
    setEditing((s) => {
      if (!s) return s;
      const v = s.optionDraft.trim();
      if (!v || s.options.includes(v)) return { ...s, optionDraft: "" };
      return { ...s, options: [...s.options, v], optionDraft: "" };
    });
  }

  // Rename / re-option in place (D9). The stable id + immutable key mean every ticket that
  // already carries a value for this field keeps it — editing never orphans stored values.
  async function saveEdit() {
    if (!editing) return;
    const trimmed = editing.label.trim();
    if (!trimmed) return;
    if (editing.fieldType === "select" && editing.options.length === 0) {
      toast.error("A select field needs at least one option.");
      return;
    }
    const { id, options: nextOptions, fieldType: t } = editing;
    setSavingEdit(true);
    try {
      const updated = await updateFieldDef(id, {
        label: trimmed,
        options: t === "select" ? nextOptions : undefined,
      });
      setFields((f) => f.map((x) => (x.id === id ? updated : x)));
      setEditing(null);
    } catch (e) {
      toast.error(
        e instanceof Error && /409|exists/i.test(e.message)
          ? "A field with that key already exists."
          : "Couldn't save the field.",
      );
    } finally {
      setSavingEdit(false);
    }
  }

  async function remove(field: CustomFieldDef) {
    if (editing?.id === field.id) setEditing(null);
    setFields((f) => f.filter((x) => x.id !== field.id)); // optimistic
    try {
      await deleteFieldDef(field.id);
    } catch {
      toast.error("Couldn't delete the field.");
      load();
    }
  }

  return (
    <SettingsPage
      active="custom-fields"
      title="Custom fields"
      description="Add your own attributes to tickets — they appear on each ticket's detail and are addressable by key from the API."
      status={status}
      onRetry={load}
      errorTitle="Couldn't load your custom fields"
    >
            <div className="max-w-2xl px-6 pb-10 pt-4">
              {/* Existing fields */}
              <div className="mb-6 overflow-hidden rounded-xl border bg-card shadow-sm">
                {fields.length === 0 ? (
                  <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                    No custom fields yet. Add your first below.
                  </p>
                ) : (
                  <ul className="divide-y">
                    {fields.map((f) =>
                      editing?.id === f.id ? (
                        <li key={f.id} className="space-y-2.5 px-4 py-3">
                          <div className="flex items-center gap-2">
                            <Input
                              value={editing.label}
                              autoFocus
                              className="h-8"
                              onChange={(e) => setEditing((s) => (s ? { ...s, label: e.target.value } : s))}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && editing.fieldType !== "select") void saveEdit();
                                if (e.key === "Escape") setEditing(null);
                              }}
                            />
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {TYPE_LABEL[f.field_type]}
                            </span>
                            <Button size="icon" className="size-8 shrink-0" disabled={savingEdit || !editing.label.trim()} onClick={() => void saveEdit()} title="Save" aria-label="Save">
                              {savingEdit ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <Check />}
                            </Button>
                            <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={() => setEditing(null)} title="Cancel" aria-label="Cancel">
                              <X />
                            </Button>
                          </div>
                          <code className="block text-xs text-muted-foreground">{f.key}</code>
                          {editing.fieldType === "select" && (
                            <div className="space-y-1.5">
                              {editing.options.length > 0 && (
                                <div className="flex flex-wrap gap-1.5">
                                  {editing.options.map((o) => (
                                    <span key={o} className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-xs">
                                      {o}
                                      <button
                                        type="button"
                                        onClick={() => setEditing((s) => (s ? { ...s, options: s.options.filter((x) => x !== o) } : s))}
                                        aria-label={`Remove ${o}`}
                                      >
                                        <X className="size-3 text-muted-foreground hover:text-foreground" />
                                      </button>
                                    </span>
                                  ))}
                                </div>
                              )}
                              <div className="flex gap-2">
                                <Input
                                  value={editing.optionDraft}
                                  placeholder="Add an option…"
                                  className="h-8"
                                  onChange={(e) => setEditing((s) => (s ? { ...s, optionDraft: e.target.value } : s))}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                      e.preventDefault();
                                      addEditOption();
                                    }
                                  }}
                                />
                                <Button type="button" variant="outline" size="sm" className="h-8" onClick={addEditOption} disabled={!editing.optionDraft.trim()}>
                                  Add
                                </Button>
                              </div>
                            </div>
                          )}
                        </li>
                      ) : (
                        <li key={f.id} className="flex items-center gap-3 px-4 py-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium">{f.label}</span>
                              <span className="text-xs text-muted-foreground">
                                {TYPE_LABEL[f.field_type]}
                              </span>
                            </div>
                            <code className="text-xs text-muted-foreground">{f.key}</code>
                            {f.field_type === "select" && f.options.length > 0 && (
                              <p className="mt-1 truncate text-micro text-muted-foreground">
                                {f.options.join(" · ")}
                              </p>
                            )}
                          </div>
                          <Button variant="ghost" size="icon" className="size-8" onClick={() => startEdit(f)} title="Rename or edit options" aria-label={`Edit ${f.label}`}>
                            <Pencil className="text-muted-foreground" />
                          </Button>
                          <Button variant="ghost" size="icon" className="size-8" onClick={() => void remove(f)} title="Delete field" aria-label={`Delete ${f.label}`}>
                            <Trash2 className="text-muted-foreground" />
                          </Button>
                        </li>
                      ),
                    )}
                  </ul>
                )}
              </div>

              {/* Add field */}
              <div className="space-y-4 rounded-xl border bg-card p-6 shadow-sm">
                <h2 className="text-sm font-semibold">Add a field</h2>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="cf-label">Label</Label>
                    <Input id="cf-label" value={label} placeholder="e.g. Account tier"
                      onChange={(e) => setLabel(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && fieldType !== "select") void create(); }} />
                  </div>
                  <div className="space-y-1.5">
                    {/* The label wraps the trigger so clicking it opens the menu */}
                    <Label className="flex flex-col gap-1.5">
                      <span>Type</span>
                      <PopoverSelect
                        value={fieldType}
                        align="start"
                        options={CUSTOM_FIELD_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }))}
                        onChange={(v) => {
                          if (v !== null) setFieldType(v as CustomFieldType);
                        }}
                        buttonClassName={SELECT_TRIGGER}
                      />
                    </Label>
                    <Label className="flex flex-col gap-1.5">
                      <span>Applies to</span>
                      <PopoverSelect
                        value={entity}
                        align="start"
                        options={[
                          { value: "ticket", label: "Tickets" },
                          { value: "company", label: "Companies" },
                        ]}
                        onChange={(v) => {
                          if (v !== null) setEntity(v as "ticket" | "company");
                        }}
                        buttonClassName={SELECT_TRIGGER}
                      />
                    </Label>
                  </div>
                </div>

                {fieldType === "select" && (
                  <div className="space-y-1.5">
                    <Label>Options</Label>
                    {options.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {options.map((o) => (
                          <span key={o} className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-xs">
                            {o}
                            <button type="button" onClick={() => setOptions((os) => os.filter((x) => x !== o))} aria-label={`Remove ${o}`}>
                              <X className="size-3 text-muted-foreground hover:text-foreground" />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="flex gap-2">
                      <Input value={optionDraft} placeholder="Add an option…"
                        onChange={(e) => setOptionDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addOption(); } }} />
                      <Button type="button" variant="outline" onClick={addOption} disabled={!optionDraft.trim()}>
                        Add
                      </Button>
                    </div>
                  </div>
                )}

                <Button onClick={() => void create()} disabled={creating || !label.trim()}>
                  {creating ? <><Loader2 className="animate-spin motion-reduce:animate-none" /> Adding…</> : <><Plus /> Add field</>}
                </Button>
              </div>
            </div>
    </SettingsPage>
  );
}
