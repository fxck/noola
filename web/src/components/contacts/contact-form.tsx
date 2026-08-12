import { useEffect, useState, type FormEvent } from "react";
import { Plus, Upload, X, Loader2, ChevronLeft, Star, Building2 } from "lucide-react";
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
import { fetchCompanies, ensureCompanies } from "@/lib/companies";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { type AttrRow, attrRowsOf, rowsToAttributes, IMPORT_PLACEHOLDER } from "@/components/contacts/contact-lib";
import { isSystemAttribute } from "@/lib/contact-display";

// ─────────────────────────────────────────────────────────────────────────────
// Multi-company editor (0111). An ORDERED set of company memberships — index 0 is the
// primary (server pins the contact's denormalized company columns to it). Existing companies
// are searched remotely; a typed name with no match is created on save (id stays null until
// then). The parent resolves any null-id chips via ensureCompanies before saving.
// ─────────────────────────────────────────────────────────────────────────────
export interface CompanyChip {
  id: string | null; // null = a typed name to get-or-create on save
  name: string;
}

function CompanyMultiEditor({
  value,
  onChange,
}: {
  value: CompanyChip[];
  onChange: (next: CompanyChip[]) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ id: string; name: string }[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  // Debounced remote search over existing companies.
  useEffect(() => {
    const term = q.trim();
    if (!term) { setResults([]); setLoading(false); return; }
    let live = true;
    setLoading(true);
    const t = setTimeout(() => {
      fetchCompanies({ q: term, limit: 8 })
        .then(({ companies }) => { if (live) setResults(companies.map((c) => ({ id: c.id, name: c.name }))); })
        .catch(() => { if (live) setResults([]); })
        .finally(() => { if (live) setLoading(false); });
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [q]);

  const already = (name: string, id?: string) =>
    value.some((v) => (id && v.id === id) || v.name.toLowerCase() === name.toLowerCase());

  function add(chip: CompanyChip) {
    const nm = chip.name.trim();
    if (!nm || already(nm, chip.id ?? undefined)) { setQ(""); setResults([]); setOpen(false); return; }
    onChange([...value, { id: chip.id, name: nm }]);
    setQ(""); setResults([]); setOpen(false);
  }
  const removeAt = (i: number) => onChange(value.filter((_, idx) => idx !== i));
  const makePrimary = (i: number) => { if (i > 0) onChange([value[i], ...value.filter((_, idx) => idx !== i)]); };

  const term = q.trim();
  const exact = term.length > 0 && (results.some((r) => r.name.toLowerCase() === term.toLowerCase()) || already(term));
  const showCreate = term.length > 0 && !exact;

  return (
    <div className="space-y-1.5">
      <Label htmlFor="c-company-search">{value.length > 1 ? "Companies" : "Company"}</Label>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((c, i) => (
            <span
              key={c.id ?? `new:${c.name}`}
              className="inline-flex items-center gap-1 rounded-md border bg-muted/40 py-0.5 pl-2 pr-1 text-xs"
            >
              {i === 0 ? (
                <span className="inline-flex items-center gap-1 font-medium" title="Primary company">
                  <Star className="size-3 fill-current text-amber-500" /> {c.name}
                </span>
              ) : (
                <button type="button" className="hover:underline" title="Make primary" onClick={() => makePrimary(i)}>
                  {c.name}
                </button>
              )}
              {c.id === null && <span className="text-micro text-muted-foreground">new</span>}
              <button
                type="button"
                onClick={() => removeAt(i)}
                aria-label={`Remove ${c.name}`}
                className="text-muted-foreground hover:text-destructive"
              >
                <X className="size-3.5" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <Input
          id="c-company-search"
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const hit = results.find((r) => r.name.toLowerCase() === term.toLowerCase());
              if (hit) add(hit);
              else if (term) add({ id: null, name: term });
            }
          }}
          placeholder="Search or add a company…"
          autoComplete="off"
        />
        {open && term.length > 0 && (
          <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border bg-popover shadow-md">
            {loading && <div className="px-3 py-2 text-xs text-muted-foreground">Searching…</div>}
            {!loading &&
              results
                .filter((r) => !already(r.name, r.id))
                .map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => add({ id: r.id, name: r.name })}
                  >
                    <Building2 className="size-3.5 text-muted-foreground" /> {r.name}
                  </button>
                ))}
            {showCreate && (
              <button
                type="button"
                className="flex w-full items-center gap-2 border-t px-3 py-1.5 text-left text-sm hover:bg-accent"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => add({ id: null, name: term })}
              >
                <Plus className="size-3.5 text-muted-foreground" /> Create “{term}”
              </button>
            )}
            {!loading && results.filter((r) => !already(r.name, r.id)).length === 0 && !showCreate && (
              <div className="px-3 py-2 text-xs text-muted-foreground">No matches.</div>
            )}
          </div>
        )}
      </div>
      {value.length > 1 && (
        <p className="text-micro text-muted-foreground">The starred company is primary — click another chip to promote it.</p>
      )}
    </div>
  );
}

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
  // Multi-company (0111): seed from the contact's memberships (primary first); fall back to the
  // legacy free-text `company` (id unknown → resolved/created on save) so editing an un-migrated
  // contact upgrades it to a real company link.
  const [companies, setCompanies] = useState<CompanyChip[]>(() => {
    if (initial?.companies?.length) {
      return [...initial.companies]
        .sort((a, b) => Number(b.is_primary) - Number(a.is_primary))
        .map((c) => ({ id: c.id, name: c.name }));
    }
    const nm = initial?.company?.trim();
    return nm ? [{ id: null, name: nm }] : [];
  });
  const [externalId, setExternalId] = useState(initial?.external_id ?? "");
  // Only genuine CUSTOM attributes are editable here — system-derived signals (Browser/OS/City/…) are
  // Noola-managed (shown read-only on the profile) and must not be editable, or an edit would be
  // silently reverted on the next visit and this replace-update would corrupt them.
  const [rows, setRows] = useState<AttrRow[]>(() => {
    const custom = attrRowsOf(initial).filter((r) => !r.key || !isSystemAttribute(r.key));
    return custom.length ? custom : [{ key: "", value: "" }];
  });
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
    // Preserve the Noola-managed system attributes (not shown as editable rows) so this replace-update
    // doesn't wipe them — merge them back with the edited custom rows.
    const systemAttrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(initial?.attributes ?? {})) {
      if (isSystemAttribute(k)) systemAttrs[k] = v;
    }
    setBusy(true);
    try {
      // Resolve any typed/new companies (id === null) to real ids, then build the ordered set —
      // index 0 is primary. This REPLACES the contact's full membership set server-side.
      const newNames = companies.filter((c) => c.id === null).map((c) => c.name);
      const ensured = newNames.length ? await ensureCompanies(newNames) : [];
      const idByName = new Map(ensured.map((e) => [e.name.toLowerCase(), e.id]));
      const seen = new Set<string>();
      const company_ids: string[] = [];
      for (const c of companies) {
        const id = c.id ?? idByName.get(c.name.toLowerCase());
        if (id && !seen.has(id)) { seen.add(id); company_ids.push(id); }
      }
      const input: ContactInput = {
        name: n,
        email: em || null,
        company_ids,
        external_id: externalId.trim() || null,
        attributes: { ...systemAttrs, ...rowsToAttributes(rows) },
      };
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

        {/* companies — a contact can belong to several accounts (0111); the first is primary */}
        <CompanyMultiEditor value={companies} onChange={setCompanies} />

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
  onDone: (res: { created: number; updated: number; skipped?: number; linked?: number }) => void;
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
