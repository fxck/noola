import { useEffect, useRef, useState } from "react";
import { MessageSquareText, Loader2, Trash2, Plus, Pencil, X } from "lucide-react";
import { toast } from "@/components/ui/toaster";
import { type Macro, fetchMacros, createMacro, updateMacro, deleteMacro } from "@/lib/macros";
import type { ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FormDialog } from "@/components/ui/form-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { SettingsRail } from "@/components/settings-rail";

type Status = "loading" | "ready" | "error";

export function SettingsMacrosPage() {
  const [status, setStatus] = useState<Status>("loading");
  const [macros, setMacros] = useState<Macro[]>([]);

  // The one add/edit surface: `null` closed, `"new"` create, a Macro to edit.
  const [editing, setEditing] = useState<Macro | "new" | null>(null);
  const [name, setName] = useState("");
  const [shortcut, setShortcut] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useRef(async () => {
    setStatus("loading");
    try {
      setMacros(await fetchMacros());
      setStatus("ready");
    } catch (e) {
      setStatus((e as ApiError)?.status ? "error" : "error");
    }
  }).current;

  useEffect(() => {
    void load();
  }, [load]);

  function openNew() {
    setName("");
    setShortcut("");
    setBody("");
    setFormError(null);
    setEditing("new");
  }

  function openEdit(m: Macro) {
    setName(m.name);
    setShortcut(m.shortcut ?? "");
    setBody(m.body);
    setFormError(null);
    setEditing(m);
  }

  async function save() {
    if (!name.trim() || !body.trim()) {
      setFormError("A name and a message are both required.");
      return;
    }
    const patch = { name: name.trim(), shortcut: shortcut.trim() || null, body: body.trim() };
    setSaving(true);
    setFormError(null);
    try {
      if (editing === "new") {
        const macro = await createMacro(patch);
        setMacros((m) => [macro, ...m]);
        toast.success("Macro saved.");
      } else if (editing) {
        const id = editing.id;
        const saved = await updateMacro(id, patch);
        setMacros((m) => m.map((x) => (x.id === id ? saved : x)));
        toast.success("Macro updated.");
      }
      setEditing(null);
    } catch {
      setFormError("Couldn't save the macro. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(m: Macro) {
    const prev = macros;
    setMacros((list) => list.filter((x) => x.id !== m.id));
    try {
      await deleteMacro(m.id);
      toast.success("Macro deleted.");
    } catch {
      setMacros(prev);
      toast.error("Couldn't delete the macro.");
    }
  }

  return (
    <>
      <div className="flex min-h-0 flex-1">
        <SettingsRail active="macros" />

        <div className="min-w-0 flex-1 overflow-y-auto">
          <header className="flex h-12 shrink-0 items-center gap-2 px-6">
            <h1 className="text-sm font-semibold tracking-tight">Macros</h1>
            {status === "ready" && macros.length > 0 && (
              <span className="text-sm tabular-nums text-muted-foreground">{macros.length}</span>
            )}
            {status === "ready" && (
              <Button size="sm" variant="brand" className="ml-auto gap-1.5" onClick={openNew}>
                <Plus className="size-4" /> New macro
              </Button>
            )}
          </header>
          <p className="px-6 text-small text-muted-foreground">
            Canned responses your team can drop into a reply with one click from the inbox composer.
          </p>
          <div className="max-w-3xl px-6 pb-10 pt-4">
            {status === "loading" ? (
              <RowsSkeleton rows={5} />
            ) : status === "error" ? (
              <ErrorState title="Couldn't load your macros" onRetry={() => void load()} />
            ) : macros.length === 0 ? (
              <EmptyState
                icon={MessageSquareText}
                title="No macros yet"
                description="Save a canned reply to drop it into the composer in one click."
                action={
                  <Button size="sm" variant="brand" className="gap-1.5" onClick={openNew}>
                    <Plus className="size-4" /> New macro
                  </Button>
                }
              />
            ) : (
              <div className="space-y-3">
                {macros.map((m) => (
                  <MacroRow key={m.id} macro={m} onEdit={openEdit} onDelete={onDelete} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <FormDialog
        open={editing !== null}
        size="lg"
        title={editing === "new" ? "New macro" : "Edit macro"}
        description="A reusable reply. Give it a name and, optionally, a slash shortcut."
        onClose={() => setEditing(null)}
        onSubmit={() => void save()}
        submitLabel={saving ? "Saving…" : editing === "new" ? "Add macro" : "Save changes"}
        submitDisabled={!name.trim() || !body.trim()}
        busy={saving}
      >
        <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
          <div className="space-y-1.5">
            <Label htmlFor="mname">Name</Label>
            <Input id="mname" autoFocus value={name} onChange={(e) => { setName(e.target.value); setFormError(null); }} placeholder="Password reset steps" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mshort">Shortcut <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Input id="mshort" value={shortcut} onChange={(e) => setShortcut(e.target.value)} placeholder="/reset" spellCheck={false} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mbody">Message</Label>
          <Textarea id="mbody" value={body} onChange={(e) => { setBody(e.target.value); setFormError(null); }} placeholder="Hi! To reset your password…" rows={6} />
        </div>
        {formError && <p className="text-sm text-destructive">{formError}</p>}
      </FormDialog>
    </>
  );
}

function MacroRow({
  macro: m,
  onEdit,
  onDelete,
}: {
  macro: Macro;
  onEdit: (m: Macro) => void;
  onDelete: (m: Macro) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{m.name}</span>
            {m.shortcut && (
              <code className="shrink-0 font-mono text-micro text-muted-foreground">
                {m.shortcut}
              </code>
            )}
          </div>
          <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground">{m.body}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="icon" className="size-8" onClick={() => onEdit(m)} aria-label="Edit macro">
            <Pencil className="size-4" />
          </Button>
          {confirming ? (
            <div className="flex items-center gap-1">
              <Button
                variant="destructive"
                size="sm"
                onClick={async () => { setBusy(true); try { await onDelete(m); } finally { setBusy(false); } }}
                disabled={busy}
              >
                {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : "Delete"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={busy}>
                <X />
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground hover:text-destructive"
              onClick={() => setConfirming(true)}
              aria-label="Delete macro"
            >
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
