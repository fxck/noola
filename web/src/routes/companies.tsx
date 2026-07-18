import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, getRouteApi, useNavigate } from "@tanstack/react-router";
import { Building2, Plus, ArrowLeft, Trash2, Users, Pencil, Upload, ChevronLeft, ChevronRight, Search, Download, X, SlidersHorizontal, ListFilter, Globe, Tag } from "lucide-react";
import {
  type Company,
  type CompanyDetail,
  type CompanyFilter,
  type HealthBand,
  HEALTH_META,
  fetchCompanies,
  fetchCompany,
  createCompany,
  updateCompany,
  deleteCompany,
  importCompaniesCsv,
} from "@/lib/companies";
import { relativeTime, initials, avatarHue } from "@/lib/tickets";
import { api } from "@/lib/api";
import { fetchFieldDefs, type CustomFieldDef } from "@/lib/custom-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormDialog } from "@/components/ui/form-dialog";
import { Spinner } from "@/components/ui/spinner";
import { Avatar } from "@/components/ui/avatar";
import { toast } from "@/components/ui/toaster";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { FactRow, RailSection } from "@/components/ui/rail";
import { CustomersViewSwitch } from "@/components/customers/view-switch";
import {
  useReactTable,
  getCoreRowModel,
  createColumnHelper,
  type ColumnDef,
  type SortingState,
  type PaginationState,
  type OnChangeFn,
  type RowSelectionState,
  type Table as TanstackTable,
} from "@tanstack/react-table";
import { DataTableRT } from "@/components/data-table/data-table-rt";
import { MultiSelect, type ComboOption } from "@/components/ui/combobox";
import { EntityCell, StatePill, MetricDrillCell, Checkbox, type PillTone } from "@/components/data-table/cells";
import { attributeColumns, useAttributeKeys, useHideAttrsByDefault } from "@/components/data-table/attribute-columns";
import { PageSizeSelect, DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS } from "@/components/data-table/page-size-select";
import { usePersistentVisibility, usePersistentNumber } from "@/components/data-table/persist";
import { FilterBuilder, type BuilderFieldDef } from "@/components/data-table/filter-builder";
import { type FilterCondition, splitFilterGroups } from "@/components/data-table/types";
import { cn } from "@/lib/utils";

// Companies — first-class account records with a rolled-up health score. The directory surfaces the
// riskiest accounts first (worst health on top) so an agent sees who needs attention at a glance.

// Worst-first ordering key for the health column's sort.
const SEVERITY: Record<HealthBand, number> = { critical: 0, at_risk: 1, healthy: 2 };

function HealthPill({ band, score }: { band: HealthBand; score: number }) {
  // Healthy is the default state — it renders NOTHING (§4: urgency earns color;
  // a fact identical on every row marks nothing).
  if (band === "healthy") return null;
  const m = HEALTH_META[band];
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium">
      <span className="size-2 rounded-full" style={{ background: m.dot }} />
      {m.label} <span className="tabular-nums text-muted-foreground">{score}</span>
    </span>
  );
}

// ── Companies table (UX diagnosis §4f row 3) ─────────────────────────────────
const HEALTH_TONE: Record<HealthBand, PillTone> = { healthy: "neutral", at_risk: "warning", critical: "danger" };
const HEALTH_LABEL: Record<HealthBand, string> = { healthy: "Healthy", at_risk: "At risk", critical: "Critical" };
const ccolHelp = createColumnHelper<Company>();

function buildCompanyColumns(): ColumnDef<Company, any>[] {
  return [
    ccolHelp.display({
      id: "select",
      enableSorting: false,
      enableHiding: false,
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
    }),
    ccolHelp.accessor("name", {
      header: "Company",
      enableHiding: false,
      meta: { label: "Company" },
      cell: ({ row }) => <EntityCell name={row.original.name} sub={row.original.domain || undefined} />,
    }),
    ccolHelp.accessor((c) => c.plan, {
      id: "plan",
      header: "Plan",
      meta: { label: "Plan" },
      cell: ({ row }) => (row.original.plan ? <span className="text-muted-foreground">{row.original.plan}</span> : <span className="text-muted-foreground">—</span>),
    }),
    ccolHelp.accessor((c) => c.health.band, {
      id: "health",
      header: "Health",
      meta: { label: "Health" },
      filterFn: (row, id, val: string[]) => !val?.length || val.includes(row.getValue(id)),
      sortingFn: (a, b) => SEVERITY[a.original.health.band] - SEVERITY[b.original.health.band],
      cell: ({ row }) => {
        const h = row.original.health;
        return (
          <span className="flex items-center gap-1.5">
            <StatePill label={HEALTH_LABEL[h.band]} tone={HEALTH_TONE[h.band]} dot={h.band !== "healthy"} />
            <span className="tabular-nums text-xs text-muted-foreground">{h.score}</span>
          </span>
        );
      },
    }),
    ccolHelp.accessor((c) => c.contactCount, {
      id: "contacts",
      header: "Contacts",
      meta: { label: "Contacts", align: "right" },
      cell: ({ row }) => <MetricDrillCell value={row.original.contactCount} emphasize />,
    }),
    ccolHelp.accessor((c) => c.health.openTickets, {
      id: "open",
      header: "Open",
      meta: { label: "Open tickets", align: "right" },
      cell: ({ row }) => <MetricDrillCell value={row.original.health.openTickets} emphasize />,
    }),
    ccolHelp.accessor((c) => c.health.negativeOpen, {
      id: "unhappy",
      header: "Unhappy",
      meta: { label: "Unhappy", align: "right" },
      cell: ({ row }) => {
        const n = row.original.health.negativeOpen;
        return <span className={cn("tabular-nums", n > 0 ? "font-medium text-warning" : "text-muted-foreground")}>{n > 0 ? n : "—"}</span>;
      },
    }),
    ccolHelp.accessor((c) => c.health.avgCsat ?? -1, {
      id: "csat",
      header: "CSAT",
      meta: { label: "CSAT", align: "right" },
      cell: ({ row }) => {
        const v = row.original.health.avgCsat;
        return v != null ? <span className="tabular-nums">{v}★</span> : <span className="text-muted-foreground">—</span>;
      },
    }),
  ];
}

// Column-visibility "View" control — the same pane-header control the contacts table uses, so both
// customer tables carry one chrome. Attribute columns (imported bag) show up here as options.
function ColumnVisibility({ table }: { table: TanstackTable<Company> }) {
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

// A condition with a value-requiring op but no value yet doesn't filter (still being built).
function isComplete(cond: FilterCondition): boolean {
  if (cond.op === "exists" || cond.op === "not_exists") return true;
  return (cond.value ?? "").trim() !== "";
}

const HEALTH_CUTS: { value: HealthBand | ""; label: string }[] = [
  { value: "", label: "All" },
  { value: "healthy", label: "Healthy" },
  { value: "at_risk", label: "At risk" },
  { value: "critical", label: "Critical" },
];

export function CompaniesPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [firstLoad, setFirstLoad] = useState(true);
  const [error, setError] = useState(false);
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [sorting, setSorting] = useState<SortingState>([{ id: "name", desc: false }]);
  const [pageSize, setPageSize] = usePersistentNumber("noola.pagesize.companies", DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS);
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize });
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [columnVisibility, setColumnVisibility] = usePersistentVisibility("noola.view.companies", {});
  const [reloadSignal, setReloadSignal] = useState(0);
  const [band, setBand] = useState<HealthBand | "">("");
  const [groups, setGroups] = useState<FilterCondition[][]>([[]]);
  const [showFilters, setShowFilters] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDomain, setNewDomain] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importCsv, setImportCsv] = useState("");
  const [importFile, setImportFile] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const navigate = useNavigate();
  const reload = () => setReloadSignal((n) => n + 1);

  // Debounce the search box.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const resetPage = () => setPagination((p) => (p.pageIndex === 0 ? p : { ...p, pageIndex: 0 }));
  // A re-sorted or re-filtered set makes a page-N view meaningless — jump back to page 1.
  const handleSortingChange: OnChangeFn<SortingState> = (updater) => { setSorting(updater); resetPage(); };
  useEffect(() => { resetPage(); }, [debouncedQ]);
  // Persisted rows-per-page reflows the set — sync into pagination + jump to page 1.
  useEffect(() => { setPagination((p) => (p.pageSize === pageSize ? p : { pageIndex: 0, pageSize })); }, [pageSize]);

  // Only complete conditions filter; one group ships flat as `filters`, 2+ as OR-ed `filterGroups`.
  const { flat: serverFilters, groups: serverFilterGroups } = useMemo(
    () =>
      splitFilterGroups<CompanyFilter>(
        groups.map((g) =>
          g.filter(isComplete).map((c) => ({ field: c.field, op: c.op, ...(c.value !== undefined ? { value: c.value } : {}) })),
        ),
      ),
    [groups],
  );
  // A changed band / filter set makes a page-N view meaningless — back to page 1.
  useEffect(() => { resetPage(); }, [band, serverFilters, serverFilterGroups]);

  // Fetch the current page whenever the query, sort, filters, band, or page changes.
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(false);
    fetchCompanies({
      q: debouncedQ || undefined,
      band: band || undefined,
      filters: serverFilters.length ? serverFilters : undefined,
      filterGroups: serverFilterGroups,
      sort: sorting[0]?.id,
      dir: sorting[0]?.desc ? "desc" : "asc",
      limit: pagination.pageSize,
      offset: pagination.pageIndex * pagination.pageSize,
    })
      .then((r) => { if (!live) return; setCompanies(r.companies); setTotal(r.total); })
      .catch(() => { if (live) setError(true); })
      .finally(() => { if (live) { setLoading(false); setFirstLoad(false); } });
    return () => { live = false; };
  }, [debouncedQ, band, serverFilters, serverFilterGroups, sorting, pagination.pageIndex, pagination.pageSize, reloadSignal]);

  // Core columns + one optional column per imported attribute (Intercom's "add columns").
  const attrKeys = useAttributeKeys(companies);
  useHideAttrsByDefault(attrKeys, setColumnVisibility);
  const columns = useMemo(() => [...buildCompanyColumns(), ...attributeColumns<Company>(attrKeys)], [attrKeys]);
  // Filter-builder fields: company columns + one per imported attribute (attr:<key>).
  const filterFields = useMemo<BuilderFieldDef[]>(
    () => [
      { key: "name", label: "Name", type: "text", icon: Building2 },
      { key: "domain", label: "Domain", type: "text", icon: Globe },
      { key: "plan", label: "Plan", type: "text", icon: Tag },
      ...attrKeys.map((k): BuilderFieldDef => ({ key: `attr:${k}`, label: k, type: "text", icon: Tag })),
    ],
    [attrKeys],
  );
  const condCount = groups.reduce((n, g) => n + g.length, 0);
  const filterRowVisible = showFilters || condCount > 0;
  const hasFilters = debouncedQ.trim().length > 0 || band !== "" || serverFilters.length > 0 || (serverFilterGroups?.length ?? 0) > 0;
  const pageCount = Math.max(1, Math.ceil(total / pagination.pageSize));
  const table = useReactTable({
    data: companies,
    columns,
    getRowId: (c) => c.id,
    state: { sorting, pagination, rowSelection, columnVisibility },
    manualSorting: true,
    manualPagination: true,
    manualFiltering: true,
    pageCount,
    autoResetPageIndex: false,
    onSortingChange: handleSortingChange,
    onPaginationChange: setPagination,
    onRowSelectionChange: setRowSelection,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
  });

  const busyPaging = loading && !firstLoad;
  const selectedRows = table.getSelectedRowModel().rows;
  const selectedCount = selectedRows.length;
  const from = total === 0 ? 0 : pagination.pageIndex * pagination.pageSize + 1;
  const to = pagination.pageIndex * pagination.pageSize + companies.length;
  const noun = (n: number) => (n === 1 ? "company" : "companies");

  function exportSelected() {
    const rows = selectedRows.map((r) => r.original);
    if (!rows.length) return;
    const esc = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const attrCols = [...new Set(rows.flatMap((r) => Object.keys(r.attributes ?? {})))].sort();
    const base = ["name", "domain", "plan", "contactCount", "openTickets", "health"] as const;
    const lines = [[...base, ...attrCols].join(",")];
    for (const r of rows) {
      const b = [r.name, r.domain, r.plan, r.contactCount, r.health.openTickets, r.health.band].map(esc);
      const a = attrCols.map((k) => esc(r.attributes?.[k]));
      lines.push([...b, ...a].join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `companies-${rows.length}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${rows.length} ${noun(rows.length)} to CSV.`);
  }

  async function deleteSelected() {
    const rows = selectedRows.map((r) => r.original);
    if (!rows.length) return;
    setBulkConfirm(false);
    // Optimistic: drop from the current page + count; reload() re-syncs authoritative data.
    setCompanies((prev) => prev.filter((c) => !rows.some((r) => r.id === c.id)));
    setTotal((t) => Math.max(0, t - rows.length));
    table.resetRowSelection();
    const results = await Promise.allSettled(rows.map((r) => deleteCompany(r.id)));
    const failed = results.filter((x) => x.status === "rejected").length;
    if (failed) toast.error(`Couldn't delete ${failed} ${noun(failed)}. Please try again.`);
    else toast.success(`Deleted ${rows.length} ${noun(rows.length)}.`);
    reload();
  }

  function openForm() {
    setNewName("");
    setNewDomain("");
    setFormError(null);
    setFormOpen(true);
  }

  function openImport() {
    setImportCsv("");
    setImportFile(null);
    setImportOpen(true);
  }

  function onPickCsv(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportFile(file.name);
    const reader = new FileReader();
    reader.onload = () => setImportCsv(typeof reader.result === "string" ? reader.result : "");
    reader.readAsText(file);
  }

  async function runImport() {
    if (!importCsv.trim()) return;
    setImporting(true);
    try {
      const r = await importCompaniesCsv(importCsv);
      setImportOpen(false);
      const parts = [`${r.created} created`, `${r.updated} updated`];
      if (r.skipped) parts.push(`${r.skipped} skipped`);
      toast.success(`Companies imported — ${parts.join(", ")}.`);
      reload();
    } catch (e) {
      const detail = (e as { detail?: string }).detail;
      toast.error(detail || "Couldn't import that CSV. Check it has a 'name' column.");
    } finally {
      setImporting(false);
    }
  }

  async function create() {
    const name = newName.trim();
    if (!name) {
      setFormError("Give the company a name.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      await createCompany({ name, domain: newDomain.trim() || undefined });
      setFormOpen(false);
      toast.success("Company created.");
      reload();
    } catch (e) {
      const conflict = (e as { status?: number }).status === 409;
      setFormError(conflict ? "A company with that name already exists." : "Couldn't create the company. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        {/* pane header (§3) — swaps to a bulk cluster while rows are selected, mirroring People */}
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
              <CustomersViewSwitch current="companies" />
              <span className="text-xs tabular-nums text-muted-foreground">
                {loading && firstLoad ? "loading…" : `${total.toLocaleString()} ${noun(total)}`}
              </span>
              {busyPaging && <Spinner className="size-3.5" />}
              <div className="ml-auto flex items-center gap-1.5">
                {/* health cut — quick band filter (server-side), mirrors People's identity toggle */}
                <div className="inline-flex h-8 items-center rounded-md bg-muted/60 p-0.5 text-xs">
                  {HEALTH_CUTS.map((c) => (
                    <button
                      key={c.value || "all"}
                      type="button"
                      aria-pressed={band === c.value}
                      onClick={() => setBand(c.value)}
                      className={cn(
                        "rounded px-2 py-1 transition-colors",
                        band === c.value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {c.label}
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
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search companies…"
                    aria-label="Search companies"
                    className="h-8 w-44 pl-8 text-sm lg:w-56"
                  />
                </div>
                <ColumnVisibility table={table} />
                <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={openImport}>
                  <Upload className="size-4" /> Import
                </Button>
                <Button size="sm" variant="brand" className="h-8 gap-1.5" onClick={openForm}>
                  <Plus className="size-4" /> New company
                </Button>
              </div>
            </>
          )}
        </header>

        {/* filter builder — a quiet row, only while in use. "+ Or" adds an OR-ed row. */}
        {filterRowVisible && selectedCount === 0 && (
          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
            <FilterBuilder fields={filterFields} groups={groups} onChange={setGroups} />
          </div>
        )}

        {/* table — dimmed + locked while a page fetch is in flight (mirrors People) */}
        <div
          className={cn(
            "min-h-0 flex-1 overflow-auto transition-opacity duration-150 motion-reduce:transition-none",
            busyPaging ? "pointer-events-none opacity-60" : "opacity-100",
          )}
        >
          {error && firstLoad ? (
            <ErrorState title="Couldn't load companies" onRetry={reload} />
          ) : firstLoad ? (
            <RowsSkeleton rows={8} />
          ) : total === 0 ? (
            <EmptyState
              icon={Building2}
              title={hasFilters ? "No companies match these filters." : "No companies yet"}
              description={hasFilters ? undefined : "Roll accounts up from your contacts, or add one directly."}
              action={
                !hasFilters ? (
                  <div className="flex items-center gap-1.5">
                    <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" onClick={openImport}>
                      <Upload className="size-3.5" /> Import
                    </Button>
                    <Button size="sm" variant="brand" className="h-7 gap-1 px-2 text-xs" onClick={openForm}>
                      <Plus className="size-3.5" /> New company
                    </Button>
                  </div>
                ) : undefined
              }
            />
          ) : (
            <DataTableRT table={table} onRowClick={(c) => void navigate({ to: "/companies/$companyId", params: { companyId: c.id } })} />
          )}
        </div>

        {!firstLoad && total > 0 && (
          <div className="flex shrink-0 items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground lg:px-6">
            <div className="flex items-center gap-3">
              <span className="tabular-nums">
                {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}
              </span>
              <PageSizeSelect value={pagination.pageSize} onChange={setPageSize} />
            </div>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon" className="size-7" disabled={!table.getCanPreviousPage() || busyPaging} onClick={() => table.previousPage()} aria-label="Previous page">
                <ChevronLeft className="size-4" />
              </Button>
              <Button variant="outline" size="icon" className="size-7" disabled={!table.getCanNextPage() || busyPaging} onClick={() => table.nextPage()} aria-label="Next page">
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        )}
      </div>

      <FormDialog
        open={formOpen}
        title="New company"
        description="Accounts also form automatically from your contacts' company field."
        onClose={() => setFormOpen(false)}
        onSubmit={() => void create()}
        submitLabel={saving ? "Creating…" : "Create company"}
        submitDisabled={!newName.trim()}
        busy={saving}
      >
        <div className="space-y-1.5">
          <Label htmlFor="co-name">Name</Label>
          <Input
            id="co-name"
            autoFocus
            value={newName}
            onChange={(e) => { setNewName(e.target.value); setFormError(null); }}
            placeholder="Acme Inc."
            autoComplete="off"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="co-domain">
            Domain <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id="co-domain"
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            placeholder="acme.com"
            autoComplete="off"
            spellCheck={false}
            inputMode="url"
          />
        </div>
        {formError && <p className="text-sm text-destructive">{formError}</p>}
      </FormDialog>

      <FormDialog
        open={importOpen}
        title="Import companies from CSV"
        description="Map name, domain & plan automatically — every other column is kept as a custom attribute. Re-importing updates existing companies (matched by name)."
        onClose={() => setImportOpen(false)}
        onSubmit={() => void runImport()}
        submitLabel={importing ? "Importing…" : "Import companies"}
        submitDisabled={!importCsv.trim()}
        busy={importing}
      >
        <div className="space-y-1.5">
          <Label htmlFor="co-csv">CSV file</Label>
          <Input id="co-csv" type="file" accept=".csv,text/csv" onChange={onPickCsv} />
          <p className="text-micro text-muted-foreground">
            {importFile
              ? `${importFile} — ${importCsv.split("\n").filter((l) => l.trim()).length - 1} row(s) ready`
              : "Exported from Intercom or any tool with a header row. A 'name' column is required."}
          </p>
        </div>
      </FormDialog>

      <ConfirmDialog
        open={bulkConfirm}
        title={`Delete ${selectedCount} ${noun(selectedCount)}?`}
        message="Their contacts stay, but lose their company link. This can't be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={() => void deleteSelected()}
        onCancel={() => setBulkConfirm(false)}
      />
    </>
  );
}

// ── detail ───────────────────────────────────────────────────────────────────
const routeApi = getRouteApi("/companies/$companyId");

export function CompanyDetailPage() {
  const { companyId } = routeApi.useParams();
  const navigate = useNavigate();
  const [company, setCompany] = useState<CompanyDetail | null>(null);
  // `missing` = the record is genuinely gone (404); `error` = a load failure (500 /
  // network) — kept distinct so a transient failure offers a retry instead of lying
  // that the company was deleted.
  const [state, setState] = useState<"loading" | "ok" | "missing" | "error">("loading");
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    setState("loading");
    fetchCompany(companyId)
      .then((c) => { setCompany(c); setState("ok"); })
      .catch((e) => setState((e as { status?: number }).status === 404 ? "missing" : "error"));
  }, [companyId]);

  useEffect(() => { load(); }, [load]);

  async function doDelete() {
    setDeleting(true);
    try {
      await deleteCompany(companyId);
      toast.success("Company deleted.");
      void navigate({ to: "/companies" });
    } catch {
      toast.error("Couldn't delete the company.");
      setDeleting(false); setConfirming(false);
    }
  }

  return (
    <>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* ── pane header (§3): back · avatar · name · quiet domain · actions ── */}
        <header className="flex h-12 shrink-0 items-center gap-2 px-4">
          <Link
            to="/companies"
            aria-label="Back to companies"
            className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowLeft className="size-4" />
          </Link>
          {company && state === "ok" && (
            <>
              <span
                className="grid size-6 shrink-0 place-items-center rounded-md text-micro font-semibold uppercase text-white"
                style={{ backgroundColor: `hsl(${avatarHue(company.name)} 42% 45%)` }}
              >
                {initials(company.name)}
              </span>
              <h1 className="min-w-0 truncate text-sm font-semibold tracking-tight">{company.name}</h1>
              {company.domain && (
                <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:block">
                  {company.domain}
                </span>
              )}
              <div className="ml-auto flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-muted-foreground hover:text-destructive"
                  title="Delete company"
                  aria-label="Delete company"
                  onClick={() => setConfirming(true)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </>
          )}
        </header>

        {state === "loading" ? (
          <div className="grid min-h-0 flex-1 place-items-center py-16"><Spinner /></div>
        ) : state === "error" ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ErrorState title="Couldn't load this company" onRetry={load} />
          </div>
        ) : state === "missing" || !company ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <EmptyState
              icon={Building2}
              title="This company no longer exists"
              description="It may have been deleted."
              action={
                <Button variant="outline" size="sm" onClick={() => void navigate({ to: "/companies" })}>
                  Back to companies
                </Button>
              }
            />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            {/* ── main column: the account's substance ── */}
            <main className="min-w-0 flex-1 overflow-y-auto">
              <div className="mx-auto w-full max-w-3xl px-6 py-5">
                <section>
                  <h3 className="mb-2 text-micro font-semibold uppercase tracking-wide text-muted-foreground">
                    Account health
                  </h3>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <Metric label="Open tickets" value={company.health.openTickets} />
                    <Metric label="Unhappy (open)" value={company.health.negativeOpen} warn={company.health.negativeOpen > 0} />
                    <Metric label="Total tickets" value={company.health.totalTickets} />
                    <Metric label="Avg CSAT" value={company.health.avgCsat != null ? `${company.health.avgCsat}★` : "—"} />
                  </div>
                </section>

                {/* below xl the rail is hidden — the same facts stack here instead */}
                <div className="mt-8 xl:hidden">
                  <CompanyFacts company={company} onChanged={load} />
                </div>
              </div>
            </main>

            {/* ── facts rail (§6) ── */}
            <aside className="hidden w-72 shrink-0 overflow-y-auto border-l border-border/60 xl:block">
              <CompanyFacts company={company} onChanged={load} />
            </aside>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirming}
        title="Delete company?"
        message={company ? `${company.name} will be removed. Its contacts stay, but lose their company link.` : undefined}
        confirmLabel="Delete"
        destructive
        busy={deleting}
        onConfirm={() => void doDelete()}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}

// The rail content — pinned facts, then the People section. Rendered twice
// (rail at xl+, stacked at the end of the main column below).
function CompanyFacts({ company, onChanged }: { company: CompanyDetail; onChanged?: () => void }) {
  const abs = (s: string) => {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? undefined : d.toLocaleString();
  };
  const mrrEntry = Object.entries(company.attributes ?? {}).find(([k]) => k.toLowerCase() === "mrr");

  return (
    <>
      <CompanyEditCard company={company} onChanged={onChanged} />
      <div className="px-4 py-3">
        <dl className="flex flex-col">
          {company.domain && (
            <FactRow label="Domain">
              <span className="min-w-0 truncate">{company.domain}</span>
            </FactRow>
          )}
          {/* healthy is the default — it renders nothing (§4: urgency earns color) */}
          {company.health.band !== "healthy" && (
            <FactRow label="Health">
              <HealthPill band={company.health.band} score={company.health.score} />
            </FactRow>
          )}
          <FactRow label="People">
            <span className="tabular-nums">{company.contacts.length}</span>
          </FactRow>
          {company.plan && (
            <FactRow label="Plan">
              <span className="min-w-0 truncate">{company.plan}</span>
            </FactRow>
          )}
          {mrrEntry && (
            <FactRow label="MRR">
              <span className="min-w-0 truncate tabular-nums">{String(mrrEntry[1])}</span>
            </FactRow>
          )}
          <FactRow label="Created">
            <span title={abs(company.created_at)}>{relativeTime(company.created_at)}</span>
          </FactRow>
          <FactRow label="Last activity">
            {company.health.lastActivity ? (
              <span title={abs(company.health.lastActivity)}>{relativeTime(company.health.lastActivity)}</span>
            ) : (
              "—"
            )}
          </FactRow>
        </dl>
      </div>

      <RailSection id="company.people" icon={Users} title="People" count={company.contacts.length} defaultOpen>
        {company.contacts.length === 0 ? (
          <p className="py-1 text-xs text-muted-foreground/70">No contacts linked to this company yet.</p>
        ) : (
          <ul className="-mx-1.5 flex flex-col">
            {company.contacts.map((p) => (
              <li key={p.id}>
                <Link
                  to="/contacts/$contactId"
                  params={{ contactId: p.id }}
                  className="flex items-center gap-2 rounded-md px-1.5 py-1.5 text-small transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Avatar name={p.name || p.email || "?"} className="size-5 shrink-0 text-[9px]" />
                  <span className="min-w-0 flex-1 truncate">{p.name || "Unnamed"}</span>
                  {p.email && (
                    <span className="min-w-0 max-w-[45%] truncate text-micro text-muted-foreground">
                      {p.email}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </RailSection>
    </>
  );
}

function Metric({ label, value, warn }: { label: string; value: number | string; warn?: boolean }) {
  return (
    <div className="rounded-lg border bg-background p-3">
      <div className={`text-lg font-semibold tabular-nums ${warn ? "text-warning" : ""}`}>{value}</div>
      <div className="mt-0.5 text-micro text-muted-foreground">{label}</div>
    </div>
  );
}

// Editable company details (audit: companies were read-only after creation) — name/domain/plan
// plus the tenant's company-scoped custom fields (0090), saved together.
function CompanyEditCard({ company, onChanged }: { company: CompanyDetail; onChanged?: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(company.name);
  const [domain, setDomain] = useState(company.domain ?? "");
  const [plan, setPlan] = useState(company.plan ?? "");
  const [defs, setDefs] = useState<CustomFieldDef[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(company.name);
    setDomain(company.domain ?? "");
    setPlan(company.plan ?? "");
    void Promise.all([
      fetchFieldDefs("company"),
      api<{ values: Record<string, string> }>(`/companies/${company.id}/custom-values`),
    ])
      .then(([d, v]) => { setDefs(d); setValues(v.values); })
      .catch(() => {});
  }, [open, company]);

  async function save() {
    setSaving(true);
    try {
      await updateCompany(company.id, { name: name.trim(), domain: domain.trim() || undefined, plan: plan.trim() || undefined });
      if (defs.length) {
        await api(`/companies/${company.id}/custom-values`, { method: "PUT", body: JSON.stringify({ values }) });
      }
      toast.success("Company updated.");
      setOpen(false);
      onChanged?.();
    } catch {
      toast.error("Couldn't update the company.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border-b border-border/60 px-4 py-3">
      {!open ? (
        <Button variant="outline" size="sm" className="h-8 w-full gap-1.5" onClick={() => setOpen(true)}>
          <Pencil className="size-3.5" /> Edit company
        </Button>
      ) : (
        <div className="space-y-2.5">
          <label className="block space-y-1">
            <span className="text-micro font-medium text-muted-foreground">Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8 text-sm" />
          </label>
          <label className="block space-y-1">
            <span className="text-micro font-medium text-muted-foreground">Domain</span>
            <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="acme.com" className="h-8 text-sm" />
          </label>
          <label className="block space-y-1">
            <span className="text-micro font-medium text-muted-foreground">Plan</span>
            <Input value={plan} onChange={(e) => setPlan(e.target.value)} placeholder="Enterprise" className="h-8 text-sm" />
          </label>
          {defs.map((d) => (
            <label key={d.id} className="block space-y-1">
              <span className="text-micro font-medium text-muted-foreground">{d.label}</span>
              {d.field_type === "select" ? (
                <select
                  value={values[d.id] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [d.id]: e.target.value }))}
                  className="h-8 w-full rounded-md border bg-background px-2 text-sm"
                >
                  <option value="">—</option>
                  {d.options.map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              ) : (
                <Input
                  type={d.field_type === "number" ? "number" : d.field_type === "date" ? "date" : "text"}
                  value={values[d.id] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [d.id]: e.target.value }))}
                  className="h-8 text-sm"
                />
              )}
            </label>
          ))}
          <div className="flex gap-2 pt-1">
            <Button size="sm" className="h-8 flex-1" disabled={saving || name.trim().length < 1} onClick={() => void save()}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button size="sm" variant="ghost" className="h-8" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}
