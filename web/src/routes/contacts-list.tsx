import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearch, useRouterState, Link } from "@tanstack/react-router";
import {
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type OnChangeFn,
  type PaginationState,
  type RowSelectionState,
  type SortingState,
  type Table as TanstackTable,
} from "@tanstack/react-table";
import {
  Users,
  Plus,
  Upload,
  Download,
  Trash2,
  ChevronLeft,
  ChevronRight,
  Building2,
  Tag,
  User,
  Mail,
  MailX,
  CalendarDays,
  Clock,
  Search,
  Bookmark,
  BookmarkPlus,
  Check,
  X,
  ListFilter,
  SlidersHorizontal,
  Activity,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useLiveRefresh } from "@/lib/realtime-context";
import {
  type Contact,
  type ContactFilter,
  SUBSCRIPTION_OP_LABEL,
  fetchContacts,
  deleteContact,
  isContactsUnavailable,
} from "@/lib/contacts";
import { contactDisplayName } from "@/lib/contact-display";
import {
  type Segment,
  type SegmentDefinition,
  fetchSegments,
  createSegment,
  deleteSegment,
} from "@/lib/segments";
import { relativeTime } from "@/lib/tickets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar } from "@/components/ui/avatar";
import { avatarSrc } from "@/lib/avatar-upload";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/menu";
import { MultiSelect, type ComboOption } from "@/components/ui/combobox";
import { Spinner } from "@/components/ui/spinner";
import { CustomersViewSwitch } from "@/components/customers/view-switch";
import { toast } from "@/components/ui/toaster";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/data-table/cells";
import { DataTableRT } from "@/components/data-table/data-table-rt";
import { attributeColumns, useHideAttrsByDefault } from "@/components/data-table/attribute-columns";
import { PageSizeSelect, PAGE_SIZE_OPTIONS } from "@/components/data-table/page-size-select";
import { usePersistentVisibility, usePersistentNumber, usePersistentOrder } from "@/components/data-table/persist";
import { FilterBuilder, type BuilderFieldDef } from "@/components/data-table/filter-builder";
import {
  type FilterCondition,
  type FilterOp,
  joinFilterGroups,
  splitFilterGroups,
} from "@/components/data-table/types";
import { ContactForm, BulkImportDialog } from "@/components/contacts/contact-form";

type LoadState = "ok" | "error" | "unavailable";
const PAGE_SIZE = 25;
const DEBOUNCE_MS = 220;

// A condition with a value-requiring op but no value yet doesn't filter (still being built);
// only "complete" conditions are sent to the server.
function isComplete(cond: FilterCondition): boolean {
  if (cond.op === "exists" || cond.op === "not_exists") return true;
  return (cond.value ?? "").trim() !== "";
}

// ── URL <-> table state (deep-linkable, shareable — TanStack Router search params) ──
function parseSort(s: string | undefined): SortingState {
  if (s) {
    const [id, dir] = s.split(".");
    if (id) return [{ id, desc: dir !== "asc" }];
  }
  return [{ id: "last_seen_at", desc: true }];
}

const COLUMNS: ColumnDef<Contact>[] = [
  {
    id: "select",
    header: ({ table }) => (
      <Checkbox
        checked={table.getIsAllPageRowsSelected()}
        indeterminate={table.getIsSomePageRowsSelected()}
        onChange={() => table.toggleAllPageRowsSelected()}
        label="Select all rows on this page"
      />
    ),
    cell: ({ row }) => (
      <Checkbox checked={row.getIsSelected()} onChange={() => row.toggleSelected()} label="Select row" />
    ),
    enableSorting: false,
    enableHiding: false,
  },
  {
    accessorKey: "name",
    header: "Name",
    enableHiding: false,
    meta: { label: "Name" },
    cell: ({ row }) => (
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="relative shrink-0">
          <Avatar name={contactDisplayName(row.original)} image={avatarSrc(row.original.avatar_url)} className="size-7 text-micro" />
          {row.original.online && (
            <span
              title="Active now"
              className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-background bg-success"
            />
          )}
        </span>
        <Link
          to="/contacts/$contactId"
          params={{ contactId: row.original.id }}
          tabIndex={-1}
          onClick={(e) => e.stopPropagation()}
          title={row.original.name || row.original.email || undefined}
          className={cn(
            "block max-w-[20rem] truncate hover:underline",
            row.original.name || row.original.email ? "font-medium text-foreground" : "text-muted-foreground",
          )}
        >
          {contactDisplayName(row.original)}
        </Link>
        {/* marketing opt-out — a quiet icon, not a chip (§4); broadcasts skip them */}
        {row.original.unsubscribed_at && (
          <span
            title={`Unsubscribed from marketing ${relativeTime(row.original.unsubscribed_at)}.`}
            className="shrink-0 text-muted-foreground/60"
          >
            <MailX className="size-3.5" aria-label="Unsubscribed from marketing" />
          </span>
        )}
      </div>
    ),
  },
  {
    accessorKey: "email",
    header: "Email",
    meta: { label: "Email" },
    cell: ({ getValue }) => {
      const v = getValue() as string;
      return v ? <span className="block max-w-[16rem] truncate text-muted-foreground">{v}</span> : null;
    },
  },
  {
    accessorKey: "company",
    header: "Company",
    meta: { label: "Company" },
    cell: ({ getValue }) => {
      const v = getValue() as string;
      return v ? <span className="block max-w-[14rem] truncate" title={v}>{v}</span> : null;
    },
  },
  {
    id: "plan",
    accessorFn: (c) => c.attributes?.plan ?? "",
    header: "Plan",
    meta: { label: "Plan" },
    // Quiet text, not a chip (§4) — silence when unset, no "—" filler.
    cell: ({ getValue }) => {
      const v = getValue() as string;
      return v ? <span className="text-small text-muted-foreground">{v}</span> : null;
    },
  },
  {
    // "Last activity" = real presence (last_seen_at). We fall back to updated_at only when a
    // contact has never been seen — otherwise a bulk import (which stamps updated_at for every
    // row at once) would make this column identical everywhere. Sorts server-side on last_seen_at.
    accessorKey: "last_seen_at",
    header: "Last activity",
    meta: { align: "right", label: "Last activity" },
    cell: ({ row }) => {
      const v = row.original.last_seen_at || row.original.updated_at;
      return v ? (
        <span className="whitespace-nowrap text-muted-foreground" title={new Date(v).toLocaleString()}>
          {relativeTime(v)}
        </span>
      ) : null;
    },
  },
  // Intercom's "Signed up" — a first-class timestamp offered as an optional column (hidden by
  // default) alongside the imported attribute columns.
  {
    accessorKey: "created_at",
    header: "Signed up",
    meta: { align: "right", label: "Signed up" },
    cell: ({ getValue }) => {
      const v = getValue() as string | null;
      return v ? (
        <span className="whitespace-nowrap text-muted-foreground" title={new Date(v).toLocaleString()}>
          {relativeTime(v)}
        </span>
      ) : null;
    },
  },
];

const byName = (a: Segment, b: Segment) => a.name.localeCompare(b.name);

// The "View" column-visibility control — lifted out of the old DataTableToolbar band
// into the pane header (§3: a compact popover control, not chrome of its own).
function ColumnVisibility({ table }: { table: TanstackTable<Contact> }) {
  const cols = table.getAllColumns().filter((c) => c.getCanHide());
  const options: ComboOption[] = cols.map((c) => ({
    value: c.id,
    label: (c.columnDef.meta as { label?: string } | undefined)?.label ?? c.id,
  }));
  const values = cols.filter((c) => c.getIsVisible()).map((c) => c.id);
  return (
    <MultiSelect
      label="View"
      icon={SlidersHorizontal}
      align="end"
      searchable
      values={values}
      options={options}
      onChange={(vis) => cols.forEach((c) => c.toggleVisibility(vis.includes(c.id)))}
    />
  );
}

export function ContactsPage() {
  const navigate = useNavigate();
  const search = useSearch({ from: "/contacts" });
  // Live pathname — the URL-sync effect below must never navigate while this page isn't the
  // active route, or a post-navigation settle would replace-yank the user back to /contacts.
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Server-side: `contacts` is only the CURRENT page; `total` is the server's match count.
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<LoadState>("ok");
  const [loading, setLoading] = useState(true);
  const [reloadSignal, setReloadSignal] = useState(0);
  // Attribute keys learnt from fetched pages, so the filter builder can target them. Accumulated
  // (never shrinks in a session) since with server-side data we don't hold the full set.
  const [attrKeys, setAttrKeys] = useState<string[]>([]);

  // View state — initialised from the URL so a shared link restores the exact view.
  const [sorting, setSorting] = useState<SortingState>(() => parseSort(search.sort));
  // Filters as OR groups: rows OR together, conditions within a row AND together.
  // A single-row view round-trips through ?filters= (the legacy flat grammar);
  // two or more rows through ?filterGroups=.
  const [groups, setGroups] = useState<FilterCondition[][]>(() => {
    const sane = (raw: unknown): FilterCondition[] =>
      Array.isArray(raw)
        ? (raw.filter((c) => c && typeof c.field === "string" && typeof c.op === "string") as FilterCondition[])
        : [];
    try {
      if (search.filterGroups) {
        const raw = JSON.parse(search.filterGroups);
        if (Array.isArray(raw)) {
          const g = raw.map(sane).filter((x) => x.length > 0);
          if (g.length > 0) return g;
        }
      }
      return [sane(search.filters ? JSON.parse(search.filters) : [])];
    } catch {
      /* ignore malformed ?filters= / ?filterGroups= */
    }
    return [[]];
  });
  const [q, setQ] = useState(search.q ?? "");
  // Rows-per-page persists across reloads (localStorage), seeding pagination.
  const [pageSize, setPageSize] = usePersistentNumber("noola.pagesize.contacts", PAGE_SIZE, PAGE_SIZE_OPTIONS);
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: search.page ?? 0,
    pageSize,
  });
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  // Column choices persist per table; Signed up ships hidden by default; imported attribute columns
  // are hidden by useHideAttrsByDefault as they're discovered.
  const [columnVisibility, setColumnVisibility] = usePersistentVisibility("noola.view.contacts", { created_at: false });
  const [columnOrder, setColumnOrder] = usePersistentOrder("noola.order.contacts");

  const [editing, setEditing] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [bulkConfirm, setBulkConfirm] = useState(false);

  // ⌘K "New contact" deep-links here with ?create — open the editor once, then strip the param
  // (replace, so Back doesn't re-trigger it).
  useEffect(() => {
    if (!search.create) return;
    setEditing(true);
    void navigate({ to: "/contacts", search: (s) => ({ ...s, create: undefined }), replace: true });
  }, [search.create, navigate]);

  // Saved segments — named views persisted via lib/segments (resource "contacts"),
  // surfaced as a header Menu (tickets.tsx pattern) instead of the old SegmentBar band.
  const [segments, setSegments] = useState<Segment[]>([]);
  const [showSave, setShowSave] = useState(false);
  const [segmentName, setSegmentName] = useState("");
  // The filter-builder row is on-demand chrome: toggled from the header, forced
  // visible while conditions exist.
  const [showFilters, setShowFilters] = useState(false);
  // Identity cut: all / identified (has name or email) / anonymous (widget visitors etc.).
  const [identity, setIdentity] = useState<"" | "identified" | "anonymous">("");
  useEffect(() => {
    fetchSegments("contacts")
      .then((list) => setSegments([...list].sort(byName)))
      .catch(() => setSegments([]));
  }, []);

  // Any view-altering change (search / filters / sort) returns to the first page.
  const resetPage = () => setPagination((p) => (p.pageIndex === 0 ? p : { ...p, pageIndex: 0 }));
  // A changed rows-per-page reflows the set — sync it into pagination and jump to page 1.
  useEffect(() => {
    setPagination((p) => (p.pageSize === pageSize ? p : { ...p, pageIndex: 0, pageSize }));
  }, [pageSize]);

  // Only complete conditions filter; strip the client-only `id` for the API's grammar.
  // One group ships as the flat `filters`; two or more as `filterGroups` (OR-ed).
  const { flat: serverFilters, groups: serverFilterGroups } = useMemo(
    () =>
      splitFilterGroups<ContactFilter>(
        groups.map((g) =>
          g.filter(isComplete).map((c) => ({
            field: c.field,
            op: c.op,
            ...(c.value !== undefined ? { value: c.value } : {}),
          })),
        ),
      ),
    [groups],
  );
  const sortBy = sorting[0]?.id;
  const sortDir: "asc" | "desc" | undefined = sorting[0] ? (sorting[0].desc ? "desc" : "asc") : undefined;

  // Fetch ONLY the current page, server-filtered/-sorted/-paged. Debounced so typing a query or
  // editing filters doesn't hammer the API; the first load fires immediately. Stale responses are
  // dropped via `live`. reloadSignal forces a refetch (after mutations).
  useEffect(() => {
    let live = true;
    setLoading(true);
    const delay = contacts === null ? 0 : DEBOUNCE_MS;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetchContacts({
            q: q.trim() || undefined,
            filters: serverFilters,
            filterGroups: serverFilterGroups,
            identity: identity || undefined,
            sortBy,
            sortDir,
            limit: pagination.pageSize,
            offset: pagination.pageIndex * pagination.pageSize,
          });
          if (!live) return;
          setContacts(res.contacts);
          setTotal(res.total);
          setState("ok");
          // Grow the set of attribute keys the builder can target.
          setAttrKeys((prev) => {
            const set = new Set(prev);
            let changed = false;
            for (const c of res.contacts) {
              for (const k of Object.keys(c.attributes ?? {})) {
                if (!set.has(k)) {
                  set.add(k);
                  changed = true;
                }
              }
            }
            return changed ? [...set].sort() : prev;
          });
          // Stepped past the end (e.g. after deletes) — pull back to the first page.
          if (res.contacts.length === 0 && res.total > 0 && pagination.pageIndex > 0) {
            setPagination((p) => ({ ...p, pageIndex: 0 }));
          }
        } catch (e) {
          if (!live) return;
          setState(isContactsUnavailable(e) ? "unavailable" : "error");
        } finally {
          if (live) setLoading(false);
        }
      })();
    }, delay);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, serverFilters, serverFilterGroups, identity, sortBy, sortDir, pagination.pageIndex, pagination.pageSize, reloadSignal]);
  const reload = () => setReloadSignal((n) => n + 1);
  // Live: refetch when a contact or company changes anywhere (create/delete/edit).
  useLiveRefresh(["contact.", "company."], reload);

  // STABLE data reference for react-table. (Memoised: an inline `contacts ?? []` is a fresh ref
  // every render → autoReset fires → infinite render/navigation loop. This only changes when a
  // new page actually arrives.)
  const data = useMemo(() => contacts ?? [], [contacts]);

  // Core columns + one optional column per imported attribute (Intercom's "add columns"). New
  // attribute columns land hidden so the default view stays clean; the View menu surfaces them.
  const columns = useMemo<ColumnDef<Contact>[]>(() => [...COLUMNS, ...attributeColumns<Contact>(attrKeys)], [attrKeys]);
  useHideAttrsByDefault(attrKeys, setColumnVisibility);

  // The fields the builder targets: core columns + every attribute key seen + dates. No live
  // value counts/suggestions — with server-side data we don't hold the full set (and there's no
  // distinct-values endpoint); the free-text value input carries the UX.
  const filterFields = useMemo<BuilderFieldDef[]>(
    () => [
      { key: "name", label: "Name", type: "text", icon: User },
      { key: "email", label: "Email", type: "text", icon: Mail },
      { key: "company", label: "Company", type: "text", icon: Building2 },
      ...attrKeys.map(
        (k): BuilderFieldDef => ({
          key: `attr:${k}`,
          label: k.charAt(0).toUpperCase() + k.slice(1),
          type: "text",
          icon: Tag,
        }),
      ),
      // The event prompt — picking it asks for a contact_events name and filters on
      // event:<name> (did it / never did it / when). There's no distinct-names
      // endpoint, so the name is free text.
      { key: "event", label: "Event…", type: "event", icon: Activity },
      { key: "created_at", label: "Created", type: "date", icon: CalendarDays },
      { key: "updated_at", label: "Last activity", type: "date", icon: Clock },
      {
        // The marketing opt-out timestamp, phrased as subscription state — existence
        // ops lead ("is unsubscribed" / "is subscribed" are the common asks).
        key: "unsubscribed_at",
        label: "Subscription",
        type: "date",
        ops: ["exists", "not_exists", "after", "before"],
        opLabels: SUBSCRIPTION_OP_LABEL,
        icon: MailX,
      },
    ],
    [attrKeys],
  );

  const pageCount = Math.max(1, Math.ceil(total / pagination.pageSize));

  // Sorting changes reset to page 1 (a page-N view of a re-sorted set is meaningless).
  const handleSortingChange: OnChangeFn<SortingState> = (updater) => {
    setSorting(updater);
    resetPage();
  };

  const table = useReactTable({
    data,
    columns,
    state: { sorting, pagination, rowSelection, columnVisibility, columnOrder },
    getRowId: (c) => c.id,
    manualFiltering: true,
    manualSorting: true,
    manualPagination: true,
    pageCount,
    autoResetPageIndex: false,
    onSortingChange: handleSortingChange,
    onPaginationChange: setPagination,
    onRowSelectionChange: setRowSelection,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnOrderChange: setColumnOrder,
    getCoreRowModel: getCoreRowModel(),
  });

  // Reflect the view into the URL (one-way; hydrated on mount above). Shareable/deep-linkable.
  // Guarded so an unchanged view never re-navigates — belt-and-suspenders against any loop.
  const lastSearchRef = useRef("");
  useEffect(() => {
    // Only mirror state into the URL while /contacts is the active route — never replace-navigate
    // back here after the user has moved to another route (that was the "bounce to Customers" bug).
    if (pathname !== "/contacts") return;
    const sort = sorting[0] ? `${sorting[0].id}.${sorting[0].desc ? "desc" : "asc"}` : undefined;
    // Single row → legacy ?filters=; 2+ rows → ?filterGroups= (never both).
    const nonEmpty = groups.filter((g) => g.length > 0);
    const next = {
      q: q.trim() || undefined,
      filters: nonEmpty.length === 1 ? JSON.stringify(nonEmpty[0]) : undefined,
      filterGroups: nonEmpty.length > 1 ? JSON.stringify(nonEmpty) : undefined,
      sort,
      page: pagination.pageIndex || undefined,
    };
    const key = JSON.stringify(next);
    if (key === lastSearchRef.current) return;
    lastSearchRef.current = key;
    void navigate({ to: "/contacts", replace: true, search: next });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sorting, groups, q, pagination.pageIndex, pathname]);

  // The live view (persisted when saving a segment), and applying a saved segment's
  // definition back onto the page.
  const currentDefinition = useMemo<SegmentDefinition>(
    () => ({
      q: q.trim() || undefined,
      filters: serverFilters,
      ...(serverFilterGroups ? { filterGroups: serverFilterGroups } : {}),
      sortBy,
      sortDir,
    }),
    [q, serverFilters, serverFilterGroups, sortBy, sortDir],
  );
  function applySegment(def: SegmentDefinition) {
    setQ(def.q ?? "");
    const revive = (fs: ContactFilter[]): FilterCondition[] =>
      fs.map((f) => ({
        id: crypto.randomUUID(),
        field: f.field,
        op: f.op as FilterOp,
        value: f.value,
      }));
    setGroups(joinFilterGroups(revive(def.filters ?? []), def.filterGroups?.map(revive)));
    setSorting(def.sortBy ? [{ id: def.sortBy, desc: def.sortDir !== "asc" }] : [{ id: "last_seen_at", desc: true }]);
    resetPage();
  }

  async function saveSegmentAs() {
    const name = segmentName.trim();
    if (!name) return;
    try {
      const seg = await createSegment({ name, resource: "contacts", definition: currentDefinition });
      setSegments((prev) => [...prev, seg].sort(byName));
      setSegmentName("");
      setShowSave(false);
      toast.success(`Saved segment “${seg.name}”.`);
    } catch {
      toast.error("Couldn't save segment. Please try again.");
    }
  }

  async function removeSegment(seg: Segment) {
    const prev = segments;
    setSegments((list) => list.filter((s) => s.id !== seg.id));
    try {
      await deleteSegment(seg.id);
    } catch {
      setSegments(prev);
      toast.error("Couldn't delete segment. Please try again.");
    }
  }

  function handleSearchChange(v: string) {
    setQ(v);
    resetPage();
  }
  function handleGroupsChange(next: FilterCondition[][]) {
    setGroups(next);
    resetPage();
  }

  const selectedRows = table.getSelectedRowModel().rows;
  const selectedCount = selectedRows.length;
  const condCount = groups.reduce((n, g) => n + g.length, 0);
  const hasFilters =
    q.trim().length > 0 || serverFilters.length > 0 || (serverFilterGroups?.length ?? 0) > 0;
  const filterRowVisible = showFilters || condCount > 0;
  const pageRows = table.getRowModel().rows.length;
  const from = total === 0 ? 0 : pagination.pageIndex * pagination.pageSize + 1;
  const to = pagination.pageIndex * pagination.pageSize + pageRows;
  const busyPaging = loading && contacts !== null;

  async function deleteSelected() {
    const rows = selectedRows.map((r) => r.original);
    if (!rows.length) return;
    setBulkConfirm(false);
    // Optimistic: drop from the current page + count; `reload()` re-syncs authoritative data.
    setContacts((prev) => (prev ?? []).filter((c) => !rows.some((r) => r.id === c.id)));
    setTotal((t) => Math.max(0, t - rows.length));
    table.resetRowSelection();
    const results = await Promise.allSettled(rows.map((r) => deleteContact(r.id)));
    const failed = results.filter((x) => x.status === "rejected").length;
    if (failed) toast.error(`Couldn't delete ${failed} contact${failed === 1 ? "" : "s"}. Please try again.`);
    else toast.success(`Deleted ${rows.length} contact${rows.length === 1 ? "" : "s"}.`);
    reload();
  }

  function exportSelected() {
    const rows = selectedRows.map((r) => r.original);
    if (!rows.length) return;
    const cols = ["name", "email", "company", "external_id", "created_at", "updated_at"] as const;
    const attrCols = [...new Set(rows.flatMap((r) => Object.keys(r.attributes ?? {})))].sort();
    const esc = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [[...cols, ...attrCols].join(",")];
    for (const r of rows) {
      const base = cols.map((k) => esc((r as unknown as Record<string, unknown>)[k]));
      const attrs = attrCols.map((k) => esc(r.attributes?.[k]));
      lines.push([...base, ...attrs].join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `contacts-${rows.length}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${rows.length} contact${rows.length === 1 ? "" : "s"} to CSV.`);
  }

  return (
    <>
      {/* pane header (§3) — swaps to the bulk cluster while rows are selected,
          so exporting/deleting happens where the eye already is (no extra band) */}
      <header className="flex h-12 shrink-0 items-center gap-3 px-4">
        {selectedCount > 0 ? (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="text-sm font-semibold tabular-nums tracking-tight">{selectedCount} selected</span>
            <span className="mx-1 h-4 w-px bg-border" />
            <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={exportSelected}>
              <Download className="size-3.5" /> Export CSV
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 text-xs text-destructive hover:text-destructive"
              onClick={() => setBulkConfirm(true)}
            >
              <Trash2 className="size-3.5" /> Delete
            </Button>
            <Button variant="ghost" size="sm" className="ml-auto h-8 gap-1 text-xs" onClick={() => table.resetRowSelection()}>
              <X className="size-3.5" /> Clear
            </Button>
          </div>
        ) : (
          <>
            <h1 className="text-sm font-semibold tracking-tight">Customers</h1>
            <CustomersViewSwitch current="people" />
            <span className="text-xs tabular-nums text-muted-foreground">
              {loading && contacts === null
                ? "loading…"
                : `${total.toLocaleString()} ${total === 1 ? "contact" : "contacts"}`}
            </span>
            {busyPaging && <Spinner className="size-3.5" />}
            <div className="ml-auto flex items-center gap-1.5">
              {/* saved segments + save-current, one quiet menu */}
              {showSave ? (
                <span className="inline-flex items-center gap-1">
                  <Input
                    value={segmentName}
                    onChange={(e) => setSegmentName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveSegmentAs();
                      if (e.key === "Escape") setShowSave(false);
                    }}
                    placeholder="Segment name"
                    className="h-8 w-36 text-xs"
                    autoFocus
                  />
                  <Button size="icon" className="size-8" onClick={() => void saveSegmentAs()} disabled={!segmentName.trim()} aria-label="Save segment">
                    <Check className="size-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="size-8" onClick={() => setShowSave(false)} aria-label="Cancel">
                    <X className="size-3.5" />
                  </Button>
                </span>
              ) : (
                <Menu
                  width={224}
                  trigger={(open, toggle) => (
                    <button
                      type="button"
                      onClick={toggle}
                      aria-haspopup="menu"
                      aria-expanded={open}
                      className={cn(
                        "inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
                        open && "bg-muted/60 text-foreground",
                      )}
                    >
                      <Bookmark className="size-3.5" /> Segments
                      {segments.length > 0 && <span className="tabular-nums">{segments.length}</span>}
                    </button>
                  )}
                >
                  {segments.length === 0 && (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">No saved segments yet.</div>
                  )}
                  {segments.map((s) => (
                    <div key={s.id} className="group flex items-center rounded-md hover:bg-accent">
                      <button
                        type="button"
                        onClick={() => applySegment(s.definition)}
                        className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-small"
                      >
                        {s.name}
                      </button>
                      <button
                        type="button"
                        onClick={() => void removeSegment(s)}
                        aria-label={`Delete segment ${s.name}`}
                        className="mr-1 rounded p-1 text-muted-foreground/50 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  ))}
                  <MenuSeparator />
                  <MenuItem icon={BookmarkPlus} label="Save current view…" onSelect={() => setShowSave(true)} />
                </Menu>
              )}

              {/* identity cut — identified people vs anonymous visitors (widget etc.) */}
              <div className="inline-flex h-8 items-center rounded-md bg-muted/60 p-0.5 text-xs">
                {([["", "All"], ["identified", "Identified"], ["anonymous", "Anonymous"]] as const).map(([v, label]) => (
                  <button
                    key={v || "all"}
                    type="button"
                    aria-pressed={identity === v}
                    onClick={() => {
                      setIdentity(v);
                      resetPage();
                    }}
                    className={cn(
                      "rounded px-2 py-1 transition-colors",
                      identity === v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* filter toggle — the builder row is on-demand, pinned open while conditions exist */}
              <button
                type="button"
                onClick={() => setShowFilters((v) => !v)}
                aria-expanded={filterRowVisible}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs transition-colors hover:bg-muted/60",
                  condCount ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
                  filterRowVisible && "bg-muted/60 text-foreground",
                )}
              >
                <ListFilter className="size-3.5" />
                {condCount ? `Filter · ${condCount}` : "Filter"}
              </button>

              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={q}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  placeholder="Search name, email, company…"
                  aria-label="Search contacts"
                  className="h-8 w-44 pl-8 text-sm lg:w-56"
                />
              </div>

              <ColumnVisibility table={table} />

              <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => setImportOpen(true)}>
                <Upload className="size-4" /> Import
              </Button>
              <Button size="sm" variant="brand" className="h-8 gap-1.5" onClick={() => setEditing(true)}>
                <Plus className="size-4" /> New contact
              </Button>
            </div>
          </>
        )}
      </header>

      {/* filter builder — a quiet row, only while in use (no band chrome).
          "+ Or" adds an OR-ed row; conditions within a row AND together. */}
      {filterRowVisible && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
          <FilterBuilder fields={filterFields} groups={groups} onChange={handleGroupsChange} />
        </div>
      )}

      {/* table — dimmed + locked while a page fetch is in flight, so the current rows stay
          visible (no full-height spinner flash) yet read as stale. Reduced-motion drops the fade. */}
      <div
        className={cn(
          "min-h-0 flex-1 overflow-auto transition-opacity duration-150 motion-reduce:transition-none",
          busyPaging ? "pointer-events-none opacity-60" : "opacity-100",
        )}
      >
        {state === "unavailable" ? (
          <EmptyState icon={Users} title="Contacts aren't available on this server yet." />
        ) : loading && contacts === null ? (
          <RowsSkeleton rows={8} />
        ) : state === "error" ? (
          <ErrorState title="Couldn't load contacts" onRetry={reload} retrying={loading} />
        ) : total === 0 ? (
          <EmptyState
            icon={Users}
            title={hasFilters ? "No contacts match these filters." : "No contacts yet"}
            action={
              !hasFilters ? (
                <div className="flex items-center gap-1.5">
                  <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" onClick={() => setImportOpen(true)}>
                    <Upload className="size-3.5" /> Import
                  </Button>
                  <Button size="sm" variant="brand" className="h-7 gap-1 px-2 text-xs" onClick={() => setEditing(true)}>
                    <Plus className="size-3.5" /> New contact
                  </Button>
                </div>
              ) : undefined
            }
          />
        ) : (
          <DataTableRT
            table={table}
            onRowClick={(c) => void navigate({ to: "/contacts/$contactId", params: { contactId: c.id } })}
          />
        )}
      </div>

      {/* pagination */}
      {state === "ok" && total > 0 && (
        <div className="flex shrink-0 items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground lg:px-6">
          <div className="flex items-center gap-3">
            <span className="tabular-nums">
              {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}
            </span>
            <PageSizeSelect value={pageSize} onChange={setPageSize} />
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="size-7"
              disabled={!table.getCanPreviousPage() || busyPaging}
              onClick={() => table.previousPage()}
              aria-label="Previous page"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="size-7"
              disabled={!table.getCanNextPage() || busyPaging}
              onClick={() => table.nextPage()}
              aria-label="Next page"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}

      {/* create drawer */}
      {editing && (
        <>
          <div
            className="motion-overlay fixed inset-0 z-30 bg-black/25 backdrop-blur-[1px]"
            onClick={() => setEditing(false)}
            aria-hidden
          />
          <div className="motion-drawer fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col overflow-hidden border-l bg-background shadow-2xl">
            <ContactForm
              mode="create"
              initial={null}
              onCancel={() => setEditing(false)}
              onSaved={() => {
                setEditing(false);
                toast.success("Contact added.");
                resetPage();
                reload();
              }}
              onError={(msg) => toast.error(msg)}
            />
          </div>
        </>
      )}

      <ConfirmDialog
        open={bulkConfirm}
        title={`Delete ${selectedCount} contact${selectedCount === 1 ? "" : "s"}?`}
        message="This can't be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={() => void deleteSelected()}
        onCancel={() => setBulkConfirm(false)}
      />

      {importOpen && (
        <BulkImportDialog
          onClose={() => setImportOpen(false)}
          onDone={(res) => {
            setImportOpen(false);
            const skipped = res.skipped ? `, ${res.skipped} skipped` : "";
            const linked = res.linked ? `, ${res.linked} linked to companies` : "";
            toast.success(`Imported — ${res.created} created, ${res.updated} updated${linked}${skipped}.`);
            resetPage();
            reload();
          }}
          onError={(msg) => toast.error(msg)}
        />
      )}
    </>
  );
}
