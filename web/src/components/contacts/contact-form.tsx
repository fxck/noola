import { useState, type FormEvent } from "react";
import { Plus, Upload, X, Loader2, ChevronLeft } from "lucide-react";
import {
  type Contact,
  type ContactInput,
  type BulkImportRow,
  createContact,
  updateContact,
  bulkImportContacts,
  importContactsCsv,
  isContactsUnavailable,
} from "@/lib/contacts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { type AttrRow, attrRowsOf, rowsToAttributes, IMPORT_PLACEHOLDER } from "@/components/contacts/contact-lib";

// ─────────────────────────────────────────────────────────────────────────────
// Add / edit form.
// ─────────────────────────────────────────────────────────────────────────────
export function ContactForm({
  mode,
  initial,
  onCancel,
  onSaved,
  onError,
}: {
  mode: "create" | "edit";
  initial: Contact | null;
  onCancel: () => void;
  onSaved: (c: Contact, mode: "create" | "edit") => void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [companyName, setCompanyName] = useState(initial?.company ?? "");
  const [externalId, setExternalId] = useState(initial?.external_id ?? "");
  const [rows, setRows] = useState<AttrRow[]>(() => attrRowsOf(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setRow(i: number, patch: Partial<AttrRow>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((prev) => [...prev, { key: "", value: "" }]);
  }
  function removeRow(i: number) {
    setRows((prev) => (prev.length <= 1 ? [{ key: "", value: "" }] : prev.filter((_, idx) => idx !== i)));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const n = name.trim();
    const em = email.trim();
    if (!n && !em) {
      setError("Give the contact a name or an email.");
      return;
    }
    const input: ContactInput = {
      name: n,
      email: em || null,
      company: companyName.trim(),
      external_id: externalId.trim() || null,
      attributes: rowsToAttributes(rows),
    };
    setBusy(true);
    try {
      const saved =
        mode === "create" ? await createContact(input) : await updateContact(initial!.id, input);
      onSaved(saved, mode);
    } catch {
      onError(mode === "create" ? "Couldn't add the contact. Please try again." : "Couldn't save changes. Please try again.");
      setError("Save failed — please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="mx-auto w-full max-w-2xl p-6">
      <div className="mb-5 flex items-center gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground md:hidden"
        >
          <ChevronLeft className="size-4" />
        </button>
        <h1 className="text-xl font-semibold tracking-tight">
          {mode === "create" ? "Add contact" : "Edit contact"}
        </h1>
      </div>

      <div className="space-y-4 rounded-xl border bg-card p-6 shadow-sm">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="c-name">Name</Label>
            <Input
              id="c-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              placeholder="Ada Lovelace"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="c-email">Email</Label>
            <Input
              id="c-email"
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setError(null);
              }}
              placeholder="ada@acme.com"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="c-company">Company</Label>
            <Input
              id="c-company"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="Acme"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="c-extid">
              External ID <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="c-extid"
              value={externalId}
              onChange={(e) => setExternalId(e.target.value)}
              placeholder="usr_42"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        </div>

        {/* attributes editor */}
        <div className="space-y-2">
          <Label>Attributes</Label>
          <div className="space-y-2">
            {rows.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  value={r.key}
                  onChange={(e) => setRow(i, { key: e.target.value })}
                  placeholder="key (e.g. plan)"
                  className="h-9 flex-1"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={`Attribute ${i + 1} key`}
                />
                <Input
                  value={r.value}
                  onChange={(e) => setRow(i, { value: e.target.value })}
                  placeholder="value (e.g. Enterprise)"
                  className="h-9 flex-1"
                  autoComplete="off"
                  aria-label={`Attribute ${i + 1} value`}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-9 shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => removeRow(i)}
                  aria-label="Remove attribute"
                >
                  <X className="size-4" />
                </Button>
              </div>
            ))}
          </div>
          <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={addRow}>
            <Plus className="size-3.5" /> Add attribute
          </Button>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>

      <div className="mt-5 flex items-center gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? (
            <>
              <Loader2 className="animate-spin motion-reduce:animate-none" /> Saving…
            </>
          ) : mode === "create" ? (
            "Add contact"
          ) : (
            "Save changes"
          )}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Bulk import — paste a JSON array of rows.
// ─────────────────────────────────────────────────────────────────────────────
export function BulkImportDialog({
  onClose,
  onDone,
  onError,
}: {
  onClose: () => void;
  onDone: (res: { created: number; updated: number; skipped?: number }) => void;
  onError: (msg: string) => void;
}) {
  // Two source formats (0092): a CSV file/paste (the everyday path — export from a spreadsheet)
  // or a raw JSON array (the sync-shaped path). CSV is the default.
  const [format, setFormat] = useState<"csv" | "json">("csv");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);

  // Parse + shallow-validate: must be a JSON array of objects, each with an
  // external_id or email to match on. Returns null (and sets an error) on any miss.
  function parseRows(): BulkImportRow[] | null {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      setParseError("That isn't valid JSON. Paste an array like the example below.");
      return null;
    }
    if (!Array.isArray(data)) {
      setParseError("Expected a JSON array of contacts.");
      return null;
    }
    if (data.length === 0) {
      setParseError("The array is empty — add at least one contact.");
      return null;
    }
    const rows: BulkImportRow[] = [];
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        setParseError(`Row ${i + 1} isn't an object.`);
        return null;
      }
      const r = row as Record<string, unknown>;
      if (!r.external_id && !r.email) {
        setParseError(`Row ${i + 1} needs an external_id or email.`);
        return null;
      }
      rows.push(r as BulkImportRow);
    }
    return rows;
  }

  async function submit() {
    setParseError(null);
    setBusy(true);
    try {
      if (format === "csv") {
        if (!text.trim()) { setParseError("Paste some CSV or choose a file first."); setBusy(false); return; }
        const res = await importContactsCsv(text);
        onDone(res);
      } else {
        const rows = parseRows();
        if (!rows) { setBusy(false); return; }
        const res = await bulkImportContacts(rows);
        onDone(res);
      }
    } catch (e) {
      if (isContactsUnavailable(e)) onError("Import isn't available on this server yet.");
      else onError((e as { detail?: string }).detail || "Import failed. Check the data and try again.");
    } finally {
      setBusy(false);
    }
  }

  function onPickCsvFile(e: FormEvent<HTMLInputElement>) {
    const file = (e.target as HTMLInputElement).files?.[0];
    (e.target as HTMLInputElement).value = "";
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { setParseError("File is over 5MB."); return; }
    const reader = new FileReader();
    reader.onload = () => { setText(String(reader.result ?? "")); setParseError(null); };
    reader.readAsText(file);
  }

  let count = 0;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) count = parsed.length;
  } catch {
    /* ignore — count stays 0 until it parses */
  }

  return (
    <div
      className="motion-overlay fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Bulk import contacts"
      onClick={onClose}
    >
      <div
        className="motion-pop w-full max-w-xl rounded-xl border bg-card shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-5 py-3.5">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Upload className="size-4" /> Bulk import contacts
          </h2>
          <Button variant="ghost" size="icon" className="size-8" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </Button>
        </div>
        <div className="space-y-2 p-5">
          {/* Format toggle */}
          <div className="inline-flex rounded-lg border bg-muted/40 p-0.5 text-xs">
            {(["csv", "json"] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => { setFormat(f); setParseError(null); }}
                className={
                  f === format
                    ? "rounded-md bg-background px-3 py-1 font-medium text-foreground shadow-sm"
                    : "rounded-md px-3 py-1 text-muted-foreground hover:text-foreground"
                }
              >
                {f === "csv" ? "CSV" : "JSON"}
              </button>
            ))}
          </div>
          {format === "csv" ? (
            <p className="text-sm text-muted-foreground">
              Upload a CSV (or paste one). The first row is the header; columns{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">email</code>,{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">name</code>,{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">external_id</code> and{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">company</code> are recognized; any
              other column becomes a custom attribute. Rows need an email or external_id.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Paste a JSON array of contacts. Each row needs an{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">external_id</code> or{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">email</code> to match or insert on.
            </p>
          )}
          {format === "csv" && (
            <div>
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-xs shadow-sm hover:bg-accent">
                <Upload className="size-3.5" /> Choose CSV file
                <input type="file" accept=".csv,text/csv" className="hidden" onChange={onPickCsvFile} />
              </label>
            </div>
          )}
          <Textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setParseError(null);
            }}
            placeholder={format === "csv" ? "email,name,company\nada@example.com,Ada Lovelace,Analytical Engines" : IMPORT_PLACEHOLDER}
            className="min-h-56 font-mono text-xs"
            spellCheck={false}
            autoFocus
          />
          {parseError ? (
            <p className="text-xs text-destructive">{parseError}</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {format === "json" && count > 0 ? `${count.toLocaleString()} ${count === 1 ? "row" : "rows"} ready to import.` : " "}
            </p>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t px-5 py-3.5">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !text.trim()}>
            {busy ? (
              <>
                <Loader2 className="animate-spin motion-reduce:animate-none" /> Importing…
              </>
            ) : (
              <>
                <Upload /> Import
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
