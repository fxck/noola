import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Search,
  UploadCloud,
  Trash2,
  FileText,
  Sparkles,
  Globe,
  Plus,
  RotateCw,
  Check,
  AlertTriangle,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Folder,
  MoreHorizontal,
  X,
} from "lucide-react";
import {
  type SourceDocument,
  ACCEPT_ATTR,
  fetchDocuments,
  uploadDocument,
  deleteDocument,
} from "@/lib/documents";
import {
  type SourceRow,
  type CrawlLog,
  type CrawlLogEntry,
  fetchSources,
  fetchSource,
  createSource,
  syncSource,
  deleteSource,
  isSourcesUnavailable,
} from "@/lib/sources";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Menu, MenuItem } from "@/components/ui/menu";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Checkbox } from "@/components/data-table/cells";
import { formatBytes } from "@/lib/tickets";
import { useRealtime } from "@/lib/realtime-context";
import { useNerdMode } from "@/lib/nerd-mode";
import { compactNum, CopyId } from "@/components/live/nerd-stats";
import { FactRow } from "@/components/ui/rail";
import { SourceSettings } from "@/components/sources/source-settings";
import { cn } from "@/lib/utils";

// Poll interval while any live source is mid-crawl — the user watches the
// page count climb syncing → ok without a manual refresh.
const SYNC_POLL_MS = 2500;

// Presentation helpers + shared pieces for the Sources surface live in ./components/sources/source-lib.tsx.
import {
  relativeTime, EMBED_DIM, KIND_ICON, kindLabel,
  STATUS_META, StatusDot, docDot, sourceTitle, sourceSubtitle,
  docNoun, typeLabel, folderOf, folderBasename,
  TAB_BASE, TAB_ON, TAB_OFF, TAB_BADGE,
  type SourcesView, type PendingUpload,
} from "@/components/sources/source-lib";
import { AddSourceForm, type AddSourcePayload } from "@/components/sources/add-source-form";
import { RetrievalPanel } from "@/components/sources/retrieval-panel";

export function SourcesPage() {
  const { subscribe } = useRealtime();
  const { nerd } = useNerdMode();
  const navigate = useNavigate();
  const [documents, setDocuments] = useState<SourceDocument[] | null>(null);
  const [error, setError] = useState(false);

  // Which view is showing, plus a client-side name/filename filter. Sub-views
  // render in the identical frame — only the rows change (STRUCTURE.md §10).
  const [view, setView] = useState<SourcesView>("connections");
  const [filter, setFilter] = useState("");

  // Retrieval ("Ask across your sources") — opt-in panel under the header.
  const [retrievalOpen, setRetrievalOpen] = useState(false);

  const [pending, setPending] = useState<PendingUpload[]>([]); // per-file ingest state
  const [dragging, setDragging] = useState(false); // files are over the page → drop overlay
  // dragenter/dragleave fire for every child crossed — count depth instead of
  // toggling, so the overlay doesn't flicker while the cursor moves over rows.
  const dragDepth = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);

  // Live sources. `sources === null` = first load; `sourcesState` distinguishes
  // a hard error from the endpoint simply not being deployed yet (404).
  const [sources, setSources] = useState<SourceRow[] | null>(null);
  const [sourcesState, setSourcesState] = useState<"ok" | "error" | "unavailable">("ok");
  const [addOpen, setAddOpen] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set()); // sync/delete in flight
  const [confirmingSource, setConfirmingSource] = useState<SourceRow | null>(null);
  const [deletingSource, setDeletingSource] = useState(false);

  // Selection (bulk). One model per view — switching views clears it, so the
  // header's bulk cluster can never refer to rows the operator can't see.
  const [selectedSources, setSelectedSources] = useState<Set<string>>(new Set());
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(new Set());
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [bulkConfirm, setBulkConfirm] = useState(false);

  const load = useRef(async () => {
    try {
      setDocuments(await fetchDocuments());
    } catch {
      setError(true);
    }
  }).current;

  const loadSources = useRef(async () => {
    try {
      setSources(await fetchSources());
      setSourcesState("ok");
    } catch (e) {
      setSourcesState(isSourcesUnavailable(e) ? "unavailable" : "error");
    }
  }).current;

  useEffect(() => {
    void load();
    void loadSources();
  }, [load, loadSources]);

  // Live: ingest finishing, a crawl progressing, or another agent adding a
  // source refreshes both lists. The same bus carries `noola.source.synced`.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribe(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void load();
        void loadSources();
      }, 400);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [subscribe, load, loadSources]);

  // While any source is mid-crawl, poll so the page count climbs live even if
  // no realtime event lands. Stops the moment nothing is syncing.
  const anySyncing = (sources ?? []).some((s) => s.status === "syncing");
  useEffect(() => {
    if (!anySyncing) return;
    const t = setInterval(() => void loadSources(), SYNC_POLL_MS);
    return () => clearInterval(t);
  }, [anySyncing, loadSources]);

  const docsById = useMemo(() => {
    const m = new Map<string, SourceDocument>();
    for (const d of documents ?? []) m.set(d.id, d);
    return m;
  }, [documents]);

  // Nerd totals across all uploaded documents.
  const totals = useMemo(() => {
    const docs = documents ?? [];
    let chunks = 0;
    let chars = 0;
    for (const d of docs) {
      chunks += d.chunk_count;
      chars += d.char_count;
    }
    return { docs: docs.length, chunks, chars };
  }, [documents]);

  // Nerd totals across live sources.
  const sourceTotals = useMemo(() => {
    const list = sources ?? [];
    let pages = 0;
    for (const s of list) pages += s.doc_count;
    return { count: list.length, pages };
  }, [sources]);

  // Prune stale selections when a realtime reload drops rows out from under us.
  useEffect(() => {
    setSelectedSources((prev) => {
      if (!prev.size) return prev;
      const ids = new Set((sources ?? []).map((s) => s.id));
      const next = new Set<string>();
      let changed = false;
      prev.forEach((id) => (ids.has(id) ? next.add(id) : (changed = true)));
      return changed ? next : prev;
    });
  }, [sources]);
  useEffect(() => {
    setSelectedDocs((prev) => {
      if (!prev.size) return prev;
      const ids = new Set((documents ?? []).map((d) => d.id));
      const next = new Set<string>();
      let changed = false;
      prev.forEach((id) => (ids.has(id) ? next.add(id) : (changed = true)));
      return changed ? next : prev;
    });
  }, [documents]);

  // Upload files concurrently (a small worker pool, cap 3 — parallel enough to
  // feel fast without firing dozens of simultaneous requests on a big drop),
  // each tracking its own state so the strip shows a live row per file
  // (progress bar → check, or an error the user can dismiss). Any file that
  // lands is dropped from `pending` once the real list reloads; failed files
  // stick around so the reason stays visible.
  async function ingest(files: FileList | File[]) {
    const list = Array.from(files);
    if (!list.length) return;
    switchView("uploads"); // surface the file that's arriving
    const queued = list.map((file) => ({
      file,
      id: `up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    }));
    setPending((prev) => [
      ...prev,
      ...queued.map(({ id, file }) => ({
        id,
        name: file.name,
        size: file.size,
        progress: 0,
        state: "uploading" as const,
      })),
    ]);
    const uploadOne = async ({ id, file }: (typeof queued)[number]) => {
      try {
        await uploadDocument(file, (percent) =>
          setPending((prev) => prev.map((p) => (p.id === id ? { ...p, progress: percent } : p))),
        );
        setPending((prev) =>
          prev.map((p) => (p.id === id ? { ...p, progress: 100, state: "done" } : p)),
        );
      } catch (e) {
        const status = (e as { status?: number }).status;
        const message =
          status === 415
            ? "Unsupported type — upload a .txt, .md, or .html file."
            : "Upload failed. Try again.";
        setPending((prev) => prev.map((p) => (p.id === id ? { ...p, state: "error", message } : p)));
      }
    };
    const jobs = [...queued];
    await Promise.all(
      Array.from({ length: Math.min(3, jobs.length) }, async () => {
        for (let job = jobs.shift(); job; job = jobs.shift()) await uploadOne(job);
      }),
    );
    await load(); // pull the freshly-ingested files into the real list…
    setPending((prev) => prev.filter((p) => p.state === "error")); // …then clear the finished rows
    if (fileRef.current) fileRef.current.value = "";
  }

  const dismissPending = (id: string) => setPending((prev) => prev.filter((p) => p.id !== id));

  // Optimistic single-upload delete.
  async function remove(d: SourceDocument) {
    const snapshot = documents;
    setDocuments((prev) => (prev ?? []).filter((x) => x.id !== d.id));
    try {
      await deleteDocument(d.id);
      await load();
    } catch {
      setDocuments(snapshot);
    }
  }

  function markBusy(id: string, on: boolean) {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  // ── selection helpers ───────────────────────────────────────────────────
  const toggleSource = (id: string) =>
    setSelectedSources((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const toggleDoc = (id: string) =>
    setSelectedDocs((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const clearSelection = () => {
    setSelectedSources(new Set());
    setSelectedDocs(new Set());
  };
  // Switching views drops the other view's selection — one selection model on
  // screen at a time.
  function switchView(v: SourcesView) {
    if (v !== view) clearSelection();
    setView(v);
  }
  const toggleFolder = (f: string) =>
    setCollapsedFolders((prev) => {
      const n = new Set(prev);
      n.has(f) ? n.delete(f) : n.add(f);
      return n;
    });

  // ── live-source actions ────────────────────────────────────────────────

  // Create a source with an optimistic insert: show the crawl as already syncing while the POST
  // lands, then reconcile against the server row. The write-only token never lives on the row
  // (mirrors the server, which never echoes it back). Returns false so the form can show a retry.
  async function handleCreateSource(payload: AddSourcePayload): Promise<boolean> {
    const { kind, label, config, refreshIntervalMinutes } = payload;
    const tempId = `temp-${Date.now()}`;
    const optimistic: SourceRow = {
      id: tempId,
      kind,
      label,
      config: { ...config, token: undefined },
      status: "syncing",
      last_error: null,
      doc_count: 0,
      last_synced_at: null,
      created_at: new Date().toISOString(),
      refresh_interval_minutes: refreshIntervalMinutes,
    };
    setSources((prev) => [optimistic, ...(prev ?? [])]);
    try {
      await createSource({ kind, label: label || undefined, config, refreshIntervalMinutes });
      await loadSources(); // reconcile the temp row with the server row
      return true;
    } catch {
      setSources((prev) => (prev ?? []).filter((s) => s.id !== tempId));
      return false;
    }
  }

  async function sync(s: SourceRow) {
    markBusy(s.id, true);
    // Optimistic: flip the dot to Syncing immediately.
    setSources((prev) =>
      (prev ?? []).map((r) => (r.id === s.id ? { ...r, status: "syncing", last_error: null } : r)),
    );
    try {
      await syncSource(s.id);
      await loadSources();
    } catch {
      await loadSources(); // revert to the server's truth on failure
    } finally {
      markBusy(s.id, false);
    }
  }

  // Delete confirms through the styled dialog, then optimistically drops the row.
  async function doRemoveSource() {
    const s = confirmingSource;
    if (!s) return;
    setDeletingSource(true);
    markBusy(s.id, true);
    const snapshot = sources;
    setSources((prev) => (prev ?? []).filter((r) => r.id !== s.id)); // optimistic remove
    try {
      await deleteSource(s.id);
      await loadSources();
    } catch {
      setSources(snapshot); // revert
    } finally {
      markBusy(s.id, false);
      setDeletingSource(false);
      setConfirmingSource(null);
    }
  }

  // Bulk re-sync every selected connected source (optimistic).
  async function bulkResync() {
    const ids = [...selectedSources];
    if (!ids.length) return;
    ids.forEach((id) => markBusy(id, true));
    setSources((prev) =>
      (prev ?? []).map((r) =>
        selectedSources.has(r.id) ? { ...r, status: "syncing", last_error: null } : r,
      ),
    );
    clearSelection();
    try {
      await Promise.all(ids.map((id) => syncSource(id).catch(() => {})));
      await loadSources();
    } finally {
      ids.forEach((id) => markBusy(id, false));
    }
  }

  // Bulk delete every selected row in the active view (optimistic; restores on failure).
  async function bulkDelete() {
    const srcIds = [...selectedSources];
    const docIds = [...selectedDocs];
    setBulkConfirm(false);
    if (!srcIds.length && !docIds.length) return;
    const srcSnap = sources;
    const docSnap = documents;
    setSources((prev) => (prev ?? []).filter((s) => !selectedSources.has(s.id)));
    setDocuments((prev) => (prev ?? []).filter((d) => !selectedDocs.has(d.id)));
    clearSelection();
    try {
      await Promise.all([
        ...srcIds.map((id) => deleteSource(id)),
        ...docIds.map((id) => deleteDocument(id)),
      ]);
      await Promise.all([loadSources(), load()]);
    } catch {
      setSources(srcSnap);
      setDocuments(docSnap);
    }
  }

  // ── derived: filtered views ───────────────────────────────────────────────
  const q = filter.trim().toLowerCase();
  const matchSource = (s: SourceRow) => {
    if (!q) return true;
    const sub = sourceSubtitle(s) ?? "";
    return sourceTitle(s).toLowerCase().includes(q) || sub.toLowerCase().includes(q);
  };
  const matchDoc = (d: SourceDocument) => !q || d.filename.toLowerCase().includes(q);

  // One flat list, stable-ordered by kind then name — the kind icon per row
  // differentiates; group headers that outnumber their content are chrome.
  const displayedSources = (sources ?? [])
    .filter(matchSource)
    .sort((a, b) =>
      a.kind === b.kind
        ? sourceTitle(a).localeCompare(sourceTitle(b))
        : a.kind.localeCompare(b.kind),
    );
  const selectableSourceIds = displayedSources
    .filter((s) => !s.id.startsWith("temp-"))
    .map((s) => s.id);

  const displayedDocs = (documents ?? []).filter(matchDoc);
  const docFolders = useMemo(() => {
    const map = new Map<string, SourceDocument[]>();
    for (const d of displayedDocs) {
      const f = folderOf(d.filename);
      const bucket = map.get(f);
      if (bucket) bucket.push(d);
      else map.set(f, [d]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documents, filter]);
  const docIds = displayedDocs.map((d) => d.id);

  const allConnectedSelected =
    selectableSourceIds.length > 0 && selectableSourceIds.every((id) => selectedSources.has(id));
  const someConnectedSelected =
    !allConnectedSelected && selectableSourceIds.some((id) => selectedSources.has(id));
  const allDocsSelected = docIds.length > 0 && docIds.every((id) => selectedDocs.has(id));
  const someDocsSelected = !allDocsSelected && docIds.some((id) => selectedDocs.has(id));

  function toggleAllConnected() {
    setSelectedSources((prev) => {
      const n = new Set(prev);
      if (selectableSourceIds.every((id) => n.has(id))) selectableSourceIds.forEach((id) => n.delete(id));
      else selectableSourceIds.forEach((id) => n.add(id));
      return n;
    });
  }
  function toggleAllDocs() {
    setSelectedDocs((prev) => {
      const n = new Set(prev);
      if (docIds.every((id) => n.has(id))) docIds.forEach((id) => n.delete(id));
      else docIds.forEach((id) => n.add(id));
      return n;
    });
  }

  const selectedCount = selectedSources.size + selectedDocs.size;
  const hasSources = (sources?.length ?? 0) > 0;
  const connectionCount = sources?.length ?? 0;
  const uploadCount = documents?.length ?? 0;

  // ── connection row — full-bleed list row, no card chrome ──────────────────
  function renderConnectionRow(s: SourceRow) {
    const Icon = KIND_ICON[s.kind] ?? Globe;
    const busy = busyIds.has(s.id);
    const spinning = busy || s.status === "syncing";
    const isTemp = s.id.startsWith("temp-");
    const name = sourceTitle(s);
    const sub = sourceSubtitle(s);
    const errored = s.status === "error" && !!s.last_error;
    const selected = selectedSources.has(s.id);
    const meta = STATUS_META[s.status];
    return (
      <li
        key={s.id}
        className={cn(
          "group relative flex items-center gap-3 px-4 py-2.5 transition-colors duration-150 hover:bg-muted/50 motion-reduce:transition-none",
          selected && "bg-muted/60",
        )}
      >
        {isTemp ? (
          <span className="size-4 shrink-0" />
        ) : (
          <Checkbox checked={selected} onChange={() => toggleSource(s.id)} label={`Select ${name}`} />
        )}
        <span className="grid size-8 shrink-0 place-items-center rounded-lg border bg-muted/40 text-muted-foreground">
          <Icon className="size-4" />
        </span>
        <button
          type="button"
          disabled={isTemp}
          onClick={() => void navigate({ to: "/sources/$sourceId", params: { sourceId: s.id } })}
          className="flex min-w-0 flex-1 flex-col text-left disabled:cursor-default"
        >
          <span className="truncate text-small font-medium leading-5 group-hover:underline">
            {name}
          </span>
          <span className="truncate text-xs leading-4 text-muted-foreground" title={errored ? s.last_error ?? undefined : sub ?? undefined}>
            {errored ? (
              <span className="text-destructive">{s.last_error}</span>
            ) : sub && sub !== name ? (
              sub
            ) : (
              kindLabel(s.kind)
            )}
          </span>
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          <span className="hidden text-xs tabular-nums text-muted-foreground sm:inline">
            {compactNum(s.doc_count)} {docNoun(s)}
            {s.last_synced_at && <> · synced {relativeTime(s.last_synced_at)}</>}
          </span>
          {nerd && (
            <span className="hidden max-w-[10rem] truncate font-mono text-micro text-muted-foreground/60 lg:inline">
              {s.kind}·{s.id}
            </span>
          )}
          <StatusDot status={s.status} title={errored ? `Error: ${s.last_error}` : meta.label} />
          {!isTemp && (
            <div className="flex items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none">
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-foreground"
                disabled={spinning}
                title={spinning ? "Syncing…" : "Sync now"}
                aria-label={`Sync ${name}`}
                onClick={() => void sync(s)}
              >
                <RotateCw className={cn("size-3.5", spinning && "animate-spin motion-reduce:animate-none")} />
              </Button>
              <Menu
                width={172}
                trigger={(open, toggle) => (
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn("size-7 text-muted-foreground hover:text-foreground", open && "bg-muted text-foreground")}
                    aria-label={`More actions for ${name}`}
                    aria-haspopup="menu"
                    onClick={toggle}
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                )}
              >
                <MenuItem
                  icon={FileText}
                  label="View details"
                  onSelect={() => void navigate({ to: "/sources/$sourceId", params: { sourceId: s.id } })}
                />
                <MenuItem icon={Trash2} label="Delete" destructive disabled={busy} onSelect={() => setConfirmingSource(s)} />
              </Menu>
            </div>
          )}
        </div>
      </li>
    );
  }

  function renderDocRow(d: SourceDocument) {
    const base = folderBasename(d.filename);
    return (
      <div
        key={d.id}
        className={cn(
          "group relative flex h-9 items-center gap-2.5 px-4 transition-colors duration-150 hover:bg-muted/50 motion-reduce:transition-none",
          selectedDocs.has(d.id) && "bg-muted/60",
        )}
      >
        <Checkbox
          checked={selectedDocs.has(d.id)}
          onChange={() => toggleDoc(d.id)}
          label={`Select ${d.filename}`}
        />
        <button
          type="button"
          onClick={() => void navigate({ to: "/documents/$id", params: { id: d.id } })}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
          title={`View ${d.filename}`}
        >
          <FileText className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-small font-medium group-hover:underline">{base}</span>
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-micro tabular-nums text-muted-foreground/70">
          <span className="hidden sm:inline">
            {compactNum(d.chunk_count)} {d.chunk_count === 1 ? "chunk" : "chunks"}
          </span>
          <span className="hidden text-muted-foreground/40 sm:inline">·</span>
          <span className="hidden sm:inline">{relativeTime(d.created_at)}</span>
          {nerd && (
            <span className="hidden max-w-[11rem] truncate font-mono text-micro text-muted-foreground/60 md:inline">
              {d.status}·{compactNum(d.char_count)}c·{typeLabel(d.content_type)}
            </span>
          )}
          <StatusDot status={docDot(d)} title={d.last_error ?? undefined} />
        </div>
        <div className="flex shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none">
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:text-destructive"
            title="Delete upload"
            aria-label={`Delete ${d.filename}`}
            onClick={() => void remove(d)}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>
    );
  }

  // ── bodies ────────────────────────────────────────────────────────────────
  const connectionsBody =
    sourcesState === "unavailable" ? (
      <EmptyState
        icon={Globe}
        title="Connections aren't available yet"
        description="This server doesn't expose the live-connectors API. Uploads still work."
      />
    ) : sources === null && sourcesState === "ok" ? (
      <RowsSkeleton rows={6} />
    ) : sourcesState === "error" ? (
      <ErrorState description="Couldn't load connections." onRetry={() => void loadSources()} />
    ) : displayedSources.length === 0 ? (
      hasSources ? (
        <p className="py-12 text-center text-xs text-muted-foreground">
          No connections match your filter.
        </p>
      ) : (
        <EmptyState
          icon={Globe}
          title="No connections yet"
          description="Connect a docs URL, GitHub repo, or Discord channel — we'll crawl it, keep it fresh, and cite it in replies."
          action={
            !addOpen ? (
              <Button size="sm" className="gap-1.5" onClick={() => setAddOpen(true)}>
                <Plus className="size-3.5" /> Add connection
              </Button>
            ) : undefined
          }
        />
      )
    ) : (
      <>
        <div className="flex h-9 items-center gap-2.5 border-b border-border/50 px-4 text-xs text-muted-foreground">
          <Checkbox
            checked={allConnectedSelected}
            indeterminate={someConnectedSelected}
            onChange={toggleAllConnected}
            label="Select all connections"
          />
          <span className="tabular-nums">
            {displayedSources.length} {displayedSources.length === 1 ? "connection" : "connections"}
          </span>
        </div>
        <ul className="divide-y divide-border/50">{displayedSources.map(renderConnectionRow)}</ul>
        {nerd && sourceTotals.count > 0 && (
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 border-t px-4 py-3 font-mono text-micro tabular-nums text-muted-foreground/80">
            <span className="text-foreground/70">{compactNum(sourceTotals.count)} connected</span>
            <span className="text-muted-foreground/40">·</span>
            <span>Σ {compactNum(sourceTotals.pages)} docs</span>
          </div>
        )}
      </>
    );

  const uploadsBody = (
    <>
      {pending.length > 0 && (
        <ul className="space-y-1.5 px-4 pt-3" aria-label="Uploads in progress">
          {pending.map((p) => (
            <li
              key={p.id}
              className={cn(
                "flex items-center gap-2.5 rounded-lg border px-3 py-1.5 text-sm",
                p.state === "error" && "border-destructive/30 bg-destructive/5",
              )}
            >
              <span className="shrink-0" role="status" aria-label={p.state}>
                {p.state === "uploading" ? (
                  <Loader2 className="size-3.5 animate-spin text-primary motion-reduce:animate-none" />
                ) : p.state === "done" ? (
                  <Check className="size-3.5 text-success" />
                ) : (
                  <AlertTriangle className="size-3.5 text-destructive" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 truncate text-small font-medium" title={p.name}>
                    {p.name}
                  </span>
                  <span className="shrink-0 text-micro tabular-nums text-muted-foreground/70">
                    {formatBytes(p.size)}
                  </span>
                </div>
                {p.state === "uploading" && (
                  <div className="mt-1 h-1 overflow-hidden rounded bg-muted">
                    <div
                      className="h-full rounded bg-primary transition-[width] duration-200 ease-out motion-reduce:transition-none"
                      style={{ width: `${p.progress}%` }}
                    />
                  </div>
                )}
              </div>
              <span
                className={cn(
                  "shrink-0 text-xs tabular-nums",
                  p.state === "error" ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {p.state === "uploading" ? `${p.progress}%` : p.state === "done" ? "Indexed" : p.message}
              </span>
              {p.state === "error" && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
                  aria-label={`Dismiss ${p.name}`}
                  onClick={() => dismissPending(p.id)}
                >
                  <X className="size-3.5" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {documents === null && !error ? (
        <RowsSkeleton rows={6} className="mt-3" />
      ) : error ? (
        <ErrorState description="Couldn't load your uploads." onRetry={() => void load()} />
      ) : displayedDocs.length === 0 ? (
        (documents?.length ?? 0) > 0 ? (
          <p className="py-10 text-center text-xs text-muted-foreground">
            No files match your filter.
          </p>
        ) : pending.length === 0 ? (
          <EmptyState
            icon={UploadCloud}
            title="No uploads yet"
            description="Drop .txt, .md, or .html files anywhere on this page, or browse from your computer."
            action={
              <Button size="sm" className="gap-1.5" onClick={() => fileRef.current?.click()}>
                <UploadCloud className="size-3.5" /> Upload files
              </Button>
            }
          />
        ) : null
      ) : (
        <div className="mt-3">
          <div className="flex h-9 items-center gap-2.5 border-b border-border/50 px-4 text-xs text-muted-foreground">
            <Checkbox
              checked={allDocsSelected}
              indeterminate={someDocsSelected}
              onChange={toggleAllDocs}
              label="Select all uploads"
            />
            <span className="tabular-nums">
              {displayedDocs.length} {displayedDocs.length === 1 ? "file" : "files"}
            </span>
          </div>
          {docFolders.map(([folder, items]) => {
            const collapsed = collapsedFolders.has(folder);
            return (
              <div key={folder}>
                <button
                  type="button"
                  onClick={() => toggleFolder(folder)}
                  aria-expanded={!collapsed}
                  className="flex h-8 w-full items-center gap-1.5 border-b border-border/50 px-4 text-left text-micro font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
                >
                  <ChevronRight
                    className={cn(
                      "size-3 shrink-0 transition-transform motion-reduce:transition-none",
                      !collapsed && "rotate-90",
                    )}
                  />
                  <Folder className="size-3 shrink-0" />
                  <span className="truncate">{folder}</span>
                  <span className="tabular-nums text-muted-foreground/50">{items.length}</span>
                </button>
                {!collapsed && (
                  <div className="divide-y divide-border/40 border-b border-border/50">
                    {items.map(renderDocRow)}
                  </div>
                )}
              </div>
            );
          })}
          {nerd && (documents?.length ?? 0) > 0 && (
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-4 py-3 font-mono text-micro tabular-nums text-muted-foreground/80">
              <span className="text-foreground/70">{compactNum(totals.docs)} uploads</span>
              <span className="text-muted-foreground/40">·</span>
              <span>Σ {compactNum(totals.chunks)} chunks</span>
              <span className="text-muted-foreground/40">·</span>
              <span>Σ {compactNum(totals.chars)} chars</span>
              <span className="text-muted-foreground/40">·</span>
              <span title="all-MiniLM-L6-v2 embedding dimension">{EMBED_DIM}-d</span>
            </div>
          )}
        </div>
      )}
    </>
  );

  return (
    <>
      <div
        className="relative flex min-h-0 flex-1 flex-col"
        onDragEnter={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) e.preventDefault();
        }}
        onDragLeave={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          // A drop lands regardless of the active view — ingest switches to
          // Uploads itself, so dropping onto Connections just works.
          if (e.dataTransfer.files.length) void ingest(e.dataTransfer.files);
        }}
      >
        {/* Hidden picker — shared by drag-and-drop + the header Upload button. */}
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={ACCEPT_ATTR}
          className="hidden"
          onChange={(e) => e.target.files && void ingest(e.target.files)}
        />

        {/* ── pane header (h-12, §3) — swaps to the bulk cluster while rows are
            selected, so the selection state renders exactly once ─────────── */}
        <header className="flex h-12 shrink-0 items-center gap-3 px-4">
          {selectedCount > 0 ? (
            <>
              <span className="text-sm font-medium tabular-nums">{selectedCount} selected</span>
              <div className="ml-auto flex items-center gap-1.5">
                {selectedSources.size > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1.5 text-xs"
                    onClick={() => void bulkResync()}
                  >
                    <RotateCw className="size-3.5" /> Re-sync
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1.5 text-xs text-destructive hover:text-destructive"
                  onClick={() => setBulkConfirm(true)}
                >
                  <Trash2 className="size-3.5" /> Delete
                </Button>
                <Button size="sm" variant="ghost" className="h-8 px-2 text-xs" onClick={clearSelection}>
                  Clear
                </Button>
              </div>
            </>
          ) : (
            <>
              <h1 className="text-sm font-semibold tracking-tight">Sources</h1>
              <div
                role="tablist"
                aria-label="Sources views"
                className="inline-flex items-center gap-0.5 rounded-lg border bg-muted/60 p-0.5"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === "connections"}
                  onClick={() => switchView("connections")}
                  className={cn(TAB_BASE, view === "connections" ? TAB_ON : TAB_OFF)}
                >
                  Connections
                  {connectionCount > 0 && <span className={TAB_BADGE}>{compactNum(connectionCount)}</span>}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === "uploads"}
                  onClick={() => switchView("uploads")}
                  className={cn(TAB_BASE, view === "uploads" ? TAB_ON : TAB_OFF)}
                >
                  Uploads
                  {uploadCount > 0 && <span className={TAB_BADGE}>{compactNum(uploadCount)}</span>}
                </button>
              </div>
              <div className="ml-auto flex items-center gap-1.5">
                <div className="relative hidden md:block">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder={view === "connections" ? "Filter connections…" : "Filter files…"}
                    className="h-8 w-48 pl-8 text-sm"
                    aria-label="Filter sources by name"
                  />
                </div>
                <Button
                  size="sm"
                  variant={retrievalOpen ? "outline" : "ghost"}
                  className="h-8 gap-1.5 text-xs"
                  onClick={() => setRetrievalOpen((o) => !o)}
                  aria-pressed={retrievalOpen}
                >
                  <Sparkles className="size-3.5" />
                  <span className="hidden sm:inline">Test retrieval</span>
                </Button>
                {view === "connections" && sourcesState !== "unavailable" ? (
                  <Button
                    size="sm"
                    className="h-8 gap-1.5 text-xs"
                    onClick={() => setAddOpen(true)}
                    aria-haspopup="dialog"
                  >
                    <Plus className="size-3.5" /> Add connection
                  </Button>
                ) : view === "uploads" ? (
                  <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={() => fileRef.current?.click()}>
                    <UploadCloud className="size-3.5" /> Upload
                  </Button>
                ) : null}
              </div>
            </>
          )}
        </header>

        {/* ── add-source dialog (kind-specific fields) — mounted only while open,
            so closing discards the draft ───────────────────────────────────── */}
        {addOpen && view === "connections" && sourcesState !== "unavailable" && (
          <AddSourceForm onCreate={handleCreateSource} onClose={() => setAddOpen(false)} />
        )}

        {/* ── retrieval panel ("Ask across your sources") ──────────────────── */}
        {retrievalOpen && (
          <RetrievalPanel docsById={docsById} shell="px-4" onClose={() => setRetrievalOpen(false)} />
        )}

        {/* ── body: the active view's rows — nothing else ──────────────────── */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {view === "connections" ? connectionsBody : uploadsBody}
        </div>

        {/* ── Drive-style drop overlay — exists only while files hover, so the
            surface stays quiet the rest of the time (§3/§4) ────────────────── */}
        {dragging && (
          <div
            aria-hidden
            className="motion-overlay pointer-events-none absolute inset-0 z-20 bg-background/80 backdrop-blur-sm [animation-duration:140ms]"
          >
            <div className="absolute inset-3 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary/60">
              <UploadCloud className="size-8 text-primary" />
              <p className="text-sm font-medium">Drop files to upload</p>
              <p className="text-xs text-muted-foreground">.txt, .md, .html</p>
            </div>
          </div>
        )}
      </div>

      {/* Remove-source confirmation (styled, animated — replaces window.confirm). */}
      <ConfirmDialog
        open={!!confirmingSource}
        title="Delete source?"
        message={
          confirmingSource
            ? `“${sourceTitle(confirmingSource)}” and the ${confirmingSource.doc_count} ingested ${docNoun(
                confirmingSource,
              )} it added to your knowledge base will be permanently removed. This can't be undone.`
            : undefined
        }
        confirmLabel="Delete"
        destructive
        busy={deletingSource}
        onConfirm={() => void doRemoveSource()}
        onCancel={() => setConfirmingSource(null)}
      />

      {/* Bulk-delete confirmation. */}
      <ConfirmDialog
        open={bulkConfirm}
        title={`Delete ${selectedCount} item${selectedCount === 1 ? "" : "s"}?`}
        message={`The selected ${
          selectedSources.size > 0 && selectedDocs.size > 0
            ? "sources and uploads"
            : selectedSources.size > 0
              ? "sources"
              : "uploads"
        } and everything they added to your knowledge base will be permanently removed. This can't be undone.`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => void bulkDelete()}
        onCancel={() => setBulkConfirm(false)}
      />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Source detail — the routed, deep-linkable view of one live source: its target
// config, sync state + a "Sync now" control, and its ingested documents. Fetches
// fresh (the list row may be stale), polls while a crawl is in flight, and
// degrades to a not-found / error state like the contact detail. Delete is
// delegated up to the routed page so it can confirm + navigate back.
// ─────────────────────────────────────────────────────────────────────────────
export function SourceDetail({
  sourceId,
  nerd,
  onBack,
  onDelete,
}: {
  sourceId: string;
  nerd: boolean;
  onBack: () => void;
  onDelete: (s: SourceRow) => void;
}) {
  const { subscribe } = useRealtime();
  const [source, setSource] = useState<SourceRow | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [reloadSignal, setReloadSignal] = useState(0);

  // Initial (and retry) load — resets the not-found / error flags each attempt.
  useEffect(() => {
    let live = true;
    setNotFound(false);
    setLoadError(false);
    void (async () => {
      try {
        const fresh = await fetchSource(sourceId);
        if (live) setSource(fresh);
      } catch (e) {
        if (!live) return;
        if ((e as { status?: number }).status === 404) setNotFound(true);
        else setLoadError(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [sourceId, reloadSignal]);

  // Silent refetch — keeps the current row on screen (no spinner flicker).
  const refresh = useCallback(async () => {
    try {
      setSource(await fetchSource(sourceId));
    } catch {
      /* keep what we have — a transient blip shouldn't blank the page */
    }
  }, [sourceId]);

  // Live: a crawl finishing or progressing elsewhere refreshes this source too.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribe(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 400);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [subscribe, refresh]);

  // Poll while this source is mid-crawl so the page count climbs live.
  const isSyncing = source?.status === "syncing";
  useEffect(() => {
    if (!isSyncing) return;
    const t = setInterval(() => void refresh(), SYNC_POLL_MS);
    return () => clearInterval(t);
  }, [isSyncing, refresh]);

  async function doSync() {
    if (!source) return;
    setSyncing(true);
    setSource((prev) => (prev ? { ...prev, status: "syncing", last_error: null } : prev));
    try {
      await syncSource(source.id);
      await refresh();
    } catch {
      await refresh(); // revert to the server's truth on failure
    } finally {
      setSyncing(false);
    }
  }

  if (notFound) {
    return (
      <div className="grid h-full flex-1 place-items-center p-8 text-center">
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <AlertTriangle className="size-7 opacity-40" />
          <p className="text-sm">This source no longer exists.</p>
          <Button variant="outline" size="sm" onClick={onBack}>
            Back to sources
          </Button>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="grid h-full flex-1 place-items-center p-8">
        <div className="flex flex-col items-center gap-1">
          <ErrorState
            description="Couldn't load this source."
            onRetry={() => setReloadSignal((n) => n + 1)}
          />
          <Button variant="ghost" size="sm" onClick={onBack}>
            Back to sources
          </Button>
        </div>
      </div>
    );
  }

  const s = source;
  if (!s) {
    return <RowsSkeleton rows={6} className="flex-1" />;
  }

  const Icon = KIND_ICON[s.kind] ?? Globe;
  const spinning = syncing || s.status === "syncing";

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {/* ── entity header (§3): back · glyph · name · actions ─────────────── */}
      <header className="flex h-12 shrink-0 items-center gap-2 px-4">
        <Link
          to="/sources"
          aria-label="Back to sources"
          className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "size-8 shrink-0 text-muted-foreground")}
        >
          <ChevronLeft className="size-4" />
        </Link>
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <h1 className="min-w-0 truncate text-sm font-semibold tracking-tight">{sourceTitle(s)}</h1>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            disabled={spinning}
            onClick={() => void doSync()}
          >
            <RotateCw className={cn("size-3.5", spinning && "animate-spin motion-reduce:animate-none")} />
            {spinning ? "Syncing…" : "Sync now"}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground hover:text-destructive"
            title="Delete source"
            aria-label="Delete source"
            onClick={() => onDelete(s)}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ── main column: error banner · editable settings · documents ───── */}
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-2xl px-6 pb-8 pt-2">
            {s.status === "error" && s.last_error && (
              <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>{s.last_error}</span>
              </p>
            )}

            {/* editable settings — the form is the write surface; facts live in the rail */}
            <SourceSettings source={s} onSaved={(u) => setSource(u)} />

            {/* the source's ingested documents (summary — the crawl runs server-side) */}
            <section className="mt-6">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Documents
              </h3>
              <div className="flex items-start gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
                <p>
                  {s.doc_count > 0 ? (
                    <>
                      The {s.doc_count} ingested {docNoun(s)} are chunked and indexed. Use{" "}
                      <span className="font-medium text-foreground">Test retrieval</span> on the sources
                      page to retrieve the passages that answer a question — the same retrieval the AI will
                      cite.
                    </>
                  ) : s.status === "syncing" ? (
                    <>Crawling now — documents will appear here as they're ingested and indexed.</>
                  ) : (
                    <>
                      Nothing ingested yet. Use <span className="font-medium text-foreground">Sync now</span>{" "}
                      to crawl this source and index its content.
                    </>
                  )}
                </p>
              </div>
            </section>

            {/* crawl log — what the last sync actually did (strategy, per-page outcome, counts) */}
            <CrawlLogPanel s={s} />

            {/* facts fall back into the column when the rail is off-canvas (§5) */}
            <section className="mt-6 xl:hidden">
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Details
              </h3>
              <SourceFacts s={s} nerd={nerd} />
            </section>
          </div>
        </main>

        {/* ── facts rail (§6) — read-only at-a-glance context ──────────────── */}
        <aside className="hidden w-72 shrink-0 overflow-y-auto border-l border-border/60 xl:block">
          <div className="px-4 py-3">
            <SourceFacts s={s} nerd={nerd} />
          </div>
        </aside>
      </div>
    </div>
  );
}

// ── Crawl log ────────────────────────────────────────────────────────────────
// The per-sync telemetry the server records (sources.crawl_log): which strategy the crawl took,
// whether it found an llms.txt manifest, and each page's outcome. Turns "why did prod fetch 5
// pages and dev 338?" from a guess into something you can read.

const STRATEGY_LABEL: Record<string, string> = {
  "llms.txt": "llms.txt manifest",
  links: "same-origin link-follow",
  sitemap: "XML sitemap",
  sitemapindex: "sitemap index",
  single: "single page",
};

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function OutcomeBadge({ outcome }: { outcome: CrawlLogEntry["outcome"] }) {
  if (outcome === "markdown") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-primary" title="Indexed the clean .md twin">
        <FileText className="size-3" /> md
      </span>
    );
  }
  if (outcome === "failed") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-destructive" title="Fetch/parse failed — skipped">
        <X className="size-3" /> failed
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground" title="Indexed the HTML/text page">
      <Check className="size-3" /> html
    </span>
  );
}

function CrawlLogPanel({ s }: { s: SourceRow }) {
  const log: CrawlLog | null | undefined = s.crawl_log;
  if (!log) return null; // no sync on the crawl-log schema yet — nothing to show

  const abs = (iso: string | null) => {
    if (!iso) return undefined;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? undefined : d.toLocaleString();
  };
  const stat = (label: string, value: React.ReactNode) => (
    <div className="flex flex-col gap-0.5">
      <dt className="text-micro uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="font-mono text-sm tabular-nums text-foreground">{value}</dd>
    </div>
  );

  return (
    <section className="mt-6">
      <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Crawl log
        {log.finishedAt && (
          <span className="font-normal normal-case tracking-normal text-muted-foreground/70" title={abs(log.finishedAt)}>
            · last run {relativeTime(log.finishedAt)}
          </span>
        )}
      </h3>

      <div className="rounded-lg border">
        {/* summary strip */}
        <div className="grid grid-cols-2 gap-3 border-b bg-muted/30 p-4 sm:grid-cols-4">
          {stat(
            "Strategy",
            log.strategy ? (STRATEGY_LABEL[log.strategy] ?? log.strategy) : <span className="text-muted-foreground">—</span>,
          )}
          {stat("Pages fetched", log.pagesFetched.toLocaleString())}
          {stat(
            "Failed",
            log.pagesFailed > 0 ? <span className="text-destructive">{log.pagesFailed.toLocaleString()}</span> : "0",
          )}
          {stat("Downloaded", fmtBytes(log.totalBytes))}
        </div>

        {/* llms.txt probe + diff line */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-2.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className={cn("size-1.5 rounded-full", log.llmsTxt?.found ? "bg-primary" : "bg-muted-foreground/40")} />
            {log.llmsTxt
              ? log.llmsTxt.found
                ? `llms.txt found — ${log.llmsTxt.urls.toLocaleString()} doc URLs`
                : "no llms.txt — fell back to link-following"
              : "llms.txt not probed (non-web source)"}
          </span>
          {log.diff && (
            <span className="font-mono tabular-nums">
              +{log.diff.added} added · {log.diff.updated} updated · {log.diff.unchanged} unchanged · {log.diff.removed} removed
              {log.diff.failed > 0 && <span className="text-destructive"> · {log.diff.failed} failed to index</span>}
            </span>
          )}
        </div>

        {/* Fetched-but-not-indexed gap — the crawl pulled pages the ingest pipeline rejected. */}
        {log.diff && log.diff.failed > 0 && (
          <p className="flex items-start gap-2 border-b bg-amber-500/5 px-4 py-2.5 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {log.diff.failed.toLocaleString()} of {log.pagesFetched.toLocaleString()} fetched pages failed to index (they
              were crawled but didn't reach the knowledge base). Check the server logs for the cause.
            </span>
          </p>
        )}

        {/* error, if the sync failed */}
        {!log.ok && log.error && (
          <p className="flex items-start gap-2 border-b bg-destructive/5 px-4 py-2.5 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span className="break-words">{log.error}</span>
          </p>
        )}

        {/* per-page rows */}
        {log.entries.length > 0 ? (
          <>
            <ul className="max-h-80 divide-y divide-border/60 overflow-y-auto">
              {log.entries.map((e, i) => (
                <li key={`${e.url}-${i}`} className="flex items-center gap-3 px-4 py-1.5 text-xs">
                  <OutcomeBadge outcome={e.outcome} />
                  <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={e.url}>
                    {e.url.replace(/^https?:\/\//, "")}
                  </span>
                  {typeof e.bytes === "number" && (
                    <span className="shrink-0 font-mono tabular-nums text-muted-foreground/60">{fmtBytes(e.bytes)}</span>
                  )}
                </li>
              ))}
            </ul>
            {log.entriesTruncated && (
              <p className="border-t px-4 py-2 text-micro text-muted-foreground">
                Showing the first {log.entries.length.toLocaleString()} pages — the crawl fetched more (summary counts above
                are exact).
              </p>
            )}
          </>
        ) : (
          <p className="px-4 py-3 text-xs text-muted-foreground">No per-page detail recorded for this sync.</p>
        )}
      </div>
    </section>
  );
}

/** The source's at-a-glance facts — one dl, rendered in the xl rail and stacked
 *  into the main column below it. Status is a quiet dot + word: synced is the
 *  norm and marks nothing; only an error earns color (§4). */
function SourceFacts({ s, nerd }: { s: SourceRow; nerd: boolean }) {
  const abs = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? undefined : d.toLocaleString();
  };
  const c = s.config ?? {};
  return (
    <dl className="flex flex-col">
      <FactRow label="Kind">{kindLabel(s.kind)}</FactRow>
      <FactRow label="Status">
        <span className={cn("inline-flex items-center gap-1.5", s.status === "error" && "text-destructive")}>
          {s.status === "syncing" ? (
            <Loader2 className="size-3 animate-spin text-primary motion-reduce:animate-none" />
          ) : (
            <span
              className={cn(
                "size-1.5 rounded-full",
                s.status === "error" ? "bg-destructive" : "bg-muted-foreground/50",
              )}
            />
          )}
          {STATUS_META[s.status].label}
        </span>
      </FactRow>
      <FactRow label="Last synced">
        {s.last_synced_at ? (
          <span title={abs(s.last_synced_at)}>{relativeTime(s.last_synced_at)}</span>
        ) : (
          "Never"
        )}
      </FactRow>
      <FactRow label={s.kind === "url" ? "Pages" : "Documents"}>
        <span className="font-mono tabular-nums">{s.doc_count.toLocaleString()}</span>
      </FactRow>
      {s.kind === "url" && c.url && (
        <FactRow label="URL">
          <a
            href={c.url}
            target="_blank"
            rel="noreferrer"
            className="truncate underline-offset-2 hover:underline"
            title={c.url}
          >
            {c.url.replace(/^https?:\/\//, "")}
          </a>
        </FactRow>
      )}
      {s.kind === "github" && c.repo && (
        <FactRow label="Repository">
          <span className="truncate" title={c.repo}>
            {c.repo}
          </span>
        </FactRow>
      )}
      {s.kind === "github" && c.branch && <FactRow label="Branch">{c.branch}</FactRow>}
      {s.kind === "github" && c.path && (
        <FactRow label="Path">
          <span className="truncate font-mono text-xs" title={c.path}>
            {c.path}
          </span>
        </FactRow>
      )}
      {s.kind === "discord" && c.channelId && (
        <FactRow label="Channel">
          <span className="font-mono tabular-nums">#{c.channelId}</span>
        </FactRow>
      )}
      {s.kind === "discord" && c.guildId && (
        <FactRow label="Guild">
          <span className="font-mono tabular-nums">{c.guildId}</span>
        </FactRow>
      )}
      <FactRow label="Added">
        <span title={abs(s.created_at)}>{relativeTime(s.created_at)}</span>
      </FactRow>
      {nerd && (
        <FactRow label="ID">
          <CopyId value={s.id} className="min-w-0 font-mono text-muted-foreground" />
        </FactRow>
      )}
    </dl>
  );
}
