import { useEffect, useMemo, useRef, useState } from "react";
import { getRouteApi, Link } from "@tanstack/react-router";
import {
  type ColumnDef,
  type SortingState,
  type RowSelectionState,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  Search,
  Ticket as TicketIcon,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsUp,
  X,
  Bookmark,
  BookmarkPlus,
  Check,
  CheckCircle2,
  RotateCcw,
  Plus,
  UserRound,
  UserRoundX,
  UsersRound,
  ListFilter,
  Trash2,
} from "lucide-react";
import { InboxViewSwitch } from "@/components/inbox/view-switch";
import { Checkbox } from "@/components/ui/checkbox";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { toast } from "@/components/ui/toaster";
import {
  type TicketView,
  fetchTicketViews,
  createTicketView,
  deleteTicketView,
} from "@/lib/ticket-views";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/menu";
import { TAB_BASE, TAB_ON, TAB_OFF } from "@/components/ui/segmented";
import { DataTableRT } from "@/components/data-table/data-table-rt";
import { PRIORITY_META } from "@/components/ticket-priority";
import { SlaBadge } from "@/components/sla-badge";
import { ChannelIcon } from "@/components/inbox/badges";
import { cn } from "@/lib/utils";
import { typeDotClass } from "@/lib/ticket-types";
import {
  type Ticket,
  type TicketPriority,
  type AgentUser,
  type BulkAction,
  TICKET_PRIORITIES,
  queryTickets,
  bulkTickets,
  fetchUsers,
} from "@/lib/tickets";
import { type Team, fetchTeams } from "@/lib/teams";

const routeApi = getRouteApi("/tickets");
const PAGE_SIZE = 25;

function ago(iso: string): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const STATUS_TABS: { value: "open" | "closed" | "all"; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

// Same triage vocabulary as the inbox rows (§4): priority earns a glyph only
// when it changes triage order; everything else in the column stays silent.
function PriorityGlyph({ priority }: { priority: TicketPriority }) {
  if (priority === "urgent")
    return <ChevronsUp className="size-3.5 shrink-0 text-destructive" aria-label="Urgent priority" />;
  if (priority === "high")
    return <ChevronUp className="size-3.5 shrink-0 text-warning" aria-label="High priority" />;
  return null;
}

// The table is the list pane in table form (§10): same row anatomy, columnized.
// Noise columns die — no "Open" pills under an Open filter, no "Normal", no
// "Unassigned", no always-on SLA, tags stay with the rail/detail.
function buildColumns(showStatus: boolean): ColumnDef<Ticket>[] {
  const cols: ColumnDef<Ticket>[] = [
    {
      id: "select",
      enableSorting: false,
      header: ({ table }) => (
        <Checkbox
          checked={table.getIsAllPageRowsSelected()}
          indeterminate={table.getIsSomePageRowsSelected() && !table.getIsAllPageRowsSelected()}
          onCheckedChange={(v) => table.toggleAllPageRowsSelected(v)}
          aria-label="Select all"
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={(v) => row.toggleSelected(v)}
          onClick={(e) => e.stopPropagation()}
          aria-label="Select row"
        />
      ),
    },
    {
      accessorKey: "subject",
      header: "Subject",
      enableSorting: false,
      cell: ({ row }) => (
        // A real link so the primary cell middle/⌘-clicks into a new tab; the row's
        // onClick still handles a normal click (stopPropagation avoids double-nav).
        <Link
          to="/tickets/$ticketId"
          params={{ ticketId: row.original.id }}
          tabIndex={-1}
          onClick={(e) => e.stopPropagation()}
          className="font-medium hover:underline"
        >
          {row.original.subject || "(no subject)"}
        </Link>
      ),
    },
    {
      id: "contact",
      header: "Contact",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.contact_name ? (
          <span className="text-small text-muted-foreground">{row.original.contact_name}</span>
        ) : null,
    },
    {
      accessorKey: "priority",
      header: "Priority",
      enableSorting: true,
      cell: ({ row }) => <PriorityGlyph priority={row.original.priority} />,
    },
    {
      id: "type",
      header: "Type",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.type_name ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className={cn("size-1.5 rounded-full", typeDotClass(row.original.type_color))} />
            {row.original.type_name}
          </span>
        ) : null,
    },
    {
      id: "sla",
      header: "SLA",
      enableSorting: true,
      // Silent until it matters; a closed ticket's breach is history, not a call
      // to action (§4).
      cell: ({ row }) =>
        row.original.status === "closed" ? null : <SlaBadge sla={row.original.sla} compact />,
    },
  ];
  if (showStatus) {
    // Only the All view mixes statuses — there, closed rows say so once, quietly.
    cols.push({
      accessorKey: "status",
      header: "Status",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.status === "closed" ? (
          <span className="text-xs text-muted-foreground">Closed</span>
        ) : null,
    });
  }
  cols.push(
    {
      accessorKey: "team_name",
      header: "Team",
      enableSorting: false,
      // Subtle, like Type — the lane is context, not a signal. Empty when unrouted.
      cell: ({ row }) =>
        row.original.team_name ? (
          <span className="text-xs text-muted-foreground">{row.original.team_name}</span>
        ) : null,
    },
    {
      accessorKey: "assignee_name",
      header: "Assignee",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.assignee_name ? (
          <span title={row.original.assignee_name} className="inline-flex">
            <Avatar name={row.original.assignee_name} className="size-4 text-[8px]" />
          </span>
        ) : null,
    },
    {
      accessorKey: "channel_type",
      header: "Channel",
      enableSorting: false,
      cell: ({ row }) => <ChannelIcon channel={row.original.channel_type} />,
    },
    {
      accessorKey: "updated_at",
      header: "Updated",
      enableSorting: true,
      meta: { align: "right" },
      cell: ({ row }) => (
        <span className="tabular-nums text-xs text-muted-foreground">{ago(row.original.updated_at)}</span>
      ),
    },
  );
  return cols;
}

export function TicketsPage() {
  const search = routeApi.useSearch();
  const navigate = routeApi.useNavigate();

  const status = search.status ?? "open";
  const priorities = useMemo<TicketPriority[]>(
    () => (search.priority ? (search.priority.split(",").filter(Boolean) as TicketPriority[]) : []),
    [search.priority],
  );
  const teamFilter = search.team;
  const assigneeFilter = search.assignee;
  const page = search.page ?? 0;
  const sortBy = search.sort ?? "updated_at";
  const sortDir = search.sortDir ?? "desc";

  const [rawQ, setRawQ] = useState(search.q ?? "");
  const [page_, setPage] = useState<{ tickets: Ticket[]; total: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // Bulk selection + actions.
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [users, setUsers] = useState<AgentUser[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    fetchUsers().then(setUsers).catch(() => setUsers([]));
  }, []);
  const [teams, setTeams] = useState<Team[]>([]);
  useEffect(() => {
    fetchTeams().then(setTeams).catch(() => setTeams([]));
  }, []);

  // Saved views — named filter presets (persisted as segments, resource="tickets").
  const [views, setViews] = useState<TicketView[]>([]);
  const [showSave, setShowSave] = useState(false);
  const [viewName, setViewName] = useState("");
  useEffect(() => {
    fetchTicketViews().then(setViews).catch(() => setViews([]));
  }, []);

  const applyView = (v: TicketView) =>
    void navigate({ search: () => ({ ...v.definition, page: 0 }) });

  async function saveView() {
    const name = viewName.trim();
    if (!name) return;
    try {
      const v = await createTicketView(name, {
        status: search.status,
        priority: search.priority,
        team: search.team,
        assignee: search.assignee,
        q: search.q,
        sort: search.sort,
        sortDir: search.sortDir,
      });
      setViews((vs) => [v, ...vs]);
      setViewName("");
      setShowSave(false);
      toast.success("View saved.");
    } catch {
      toast.error("Couldn't save the view.");
    }
  }

  async function removeView(v: TicketView) {
    const prev = views;
    setViews((vs) => vs.filter((x) => x.id !== v.id));
    try {
      await deleteTicketView(v.id);
    } catch {
      setViews(prev);
      toast.error("Couldn't delete the view.");
    }
  }

  // Debounce the free-text search into the URL (which drives the fetch).
  const qTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (qTimer.current) clearTimeout(qTimer.current);
    qTimer.current = setTimeout(() => {
      const next = rawQ.trim() || undefined;
      if (next !== (search.q ?? undefined)) void navigate({ search: (s) => ({ ...s, q: next, page: 0 }) });
    }, 300);
    return () => { if (qTimer.current) clearTimeout(qTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawQ]);

  // Fetch a page whenever the URL-driven query changes.
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(false);
    queryTickets({
      status,
      priority: priorities.length ? priorities : undefined,
      teamId: teamFilter || undefined,
      assigneeId: assigneeFilter || undefined,
      q: search.q || undefined,
      sort: sortBy,
      sortDir,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    })
      .then((r) => { if (live) setPage({ tickets: r.tickets, total: r.total }); })
      .catch(() => { if (live) setError(true); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, search.priority, teamFilter, assigneeFilter, search.q, sortBy, sortDir, page, reloadKey]);

  const sorting: SortingState = useMemo(() => [{ id: sortBy, desc: sortDir === "desc" }], [sortBy, sortDir]);
  const columns = useMemo(() => buildColumns(status === "all"), [status]);

  // §2b — a signal column whose every cell would render nothing is dropped for
  // this page instead of shipping a dead header over empty space.
  const columnVisibility = useMemo(() => {
    const ts = page_?.tickets ?? [];
    const urgentSla = (t: Ticket) =>
      t.status !== "closed" &&
      !!t.sla &&
      [t.sla.firstResponse.state, t.sla.resolution.state].some((s) => s === "breached" || s === "at_risk");
    return {
      priority: ts.some((t) => t.priority === "urgent" || t.priority === "high"),
      type: ts.some((t) => !!t.type_name),
      sla: ts.some(urgentSla),
      team_name: ts.some((t) => !!t.team_name),
      assignee_name: ts.some((t) => !!t.assignee_name),
    };
  }, [page_]);

  const table = useReactTable({
    data: page_?.tickets ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    manualPagination: true,
    enableRowSelection: true,
    getRowId: (t) => t.id,
    state: { sorting, rowSelection, columnVisibility },
    onRowSelectionChange: setRowSelection,
    onSortingChange: (updater) => {
      const next = typeof updater === "function" ? updater(sorting) : updater;
      const s = next[0];
      const sort = (s?.id as "updated_at" | "created_at" | "priority" | "sla") ?? "updated_at";
      const dir = s ? (s.desc ? "desc" : "asc") : "desc";
      void navigate({ search: (cur) => ({ ...cur, sort, sortDir: dir }) });
    },
  });

  const selectedIds = Object.keys(rowSelection);
  const selectedCount = selectedIds.length;
  async function runBulk(action: BulkAction, value?: string | null) {
    if (selectedIds.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    try {
      const n = await bulkTickets(selectedIds, action, value);
      setRowSelection({});
      setTagDraft("");
      setReloadKey((k) => k + 1);
      toast.success(`Updated ${n} ticket${n === 1 ? "" : "s"}.`);
    } catch {
      toast.error("Bulk action failed.");
    } finally {
      setBulkBusy(false);
    }
  }

  const total = page_?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const setStatus = (v: "open" | "closed" | "all") => void navigate({ search: (s) => ({ ...s, status: v, page: 0 }) });
  const togglePriority = (p: TicketPriority) => {
    const next = priorities.includes(p) ? priorities.filter((x) => x !== p) : [...priorities, p];
    void navigate({ search: (s) => ({ ...s, priority: next.length ? next.join(",") : undefined, page: 0 }) });
  };
  const setTeamFilter = (t: string | undefined) =>
    void navigate({ search: (s) => ({ ...s, team: t, page: 0 }) });
  const setAssigneeFilter = (a: string | undefined) =>
    void navigate({ search: (s) => ({ ...s, assignee: a, page: 0 }) });
  const gotoPage = (n: number) => void navigate({ search: (s) => ({ ...s, page: Math.max(0, Math.min(n, pageCount - 1)) }) });
  const hasFilters = priorities.length > 0 || !!teamFilter || !!assigneeFilter || !!search.q || status !== "open";
  const teamFilterLabel =
    teamFilter === "none" ? "No team" : teams.find((t) => t.id === teamFilter)?.name;
  const assigneeFilterLabel =
    assigneeFilter === "none" ? "Unassigned" : users.find((u) => u.id === assigneeFilter)?.name;

  return (
    <>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* pane header (§3) — swaps to the bulk cluster while rows are selected,
            so approving/closing happens where the eye already is (no extra band) */}
        <header className="flex h-12 shrink-0 items-center gap-2 px-4">
          {selectedCount > 0 ? (
            <div className={cn("flex min-w-0 flex-1 items-center gap-2", bulkBusy && "opacity-60")}>
              <span className="text-sm font-semibold tabular-nums tracking-tight">{selectedCount} selected</span>
              <span className="mx-1 h-4 w-px bg-border" />
              <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" disabled={bulkBusy} onClick={() => void runBulk("close")}>
                <CheckCircle2 className="size-3.5" /> Close
              </Button>
              <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" disabled={bulkBusy} onClick={() => void runBulk("reopen")}>
                <RotateCcw className="size-3.5" /> Reopen
              </Button>
              <Menu
                align="start"
                width={176}
                trigger={(open, toggle) => (
                  <Button variant="outline" size="sm" className="h-8 gap-1 text-xs" disabled={bulkBusy} onClick={toggle} aria-haspopup="menu" aria-expanded={open}>
                    Priority <ChevronDown className="size-3.5 text-muted-foreground" />
                  </Button>
                )}
              >
                {TICKET_PRIORITIES.map((p) => (
                  <MenuItem
                    key={p}
                    label={PRIORITY_META[p].label}
                    leading={<span className={cn("size-1.5 shrink-0 rounded-full", PRIORITY_META[p].dot)} />}
                    onSelect={() => void runBulk("priority", p)}
                  />
                ))}
              </Menu>
              <Menu
                align="start"
                trigger={(open, toggle) => (
                  <Button variant="outline" size="sm" className="h-8 gap-1 text-xs" disabled={bulkBusy} onClick={toggle} aria-haspopup="menu" aria-expanded={open} aria-label="Assign selected">
                    Assign <ChevronDown className="size-3.5 text-muted-foreground" />
                  </Button>
                )}
              >
                <MenuItem icon={UserRoundX} label="Unassign" onSelect={() => void runBulk("assign", null)} />
                {users.length > 0 && <MenuSeparator />}
                {users.map((u) => (
                  <MenuItem key={u.id} icon={UserRound} label={u.name} onSelect={() => void runBulk("assign", u.id)} />
                ))}
              </Menu>
              {teams.length > 0 && (
                <Menu
                  align="start"
                  trigger={(open, toggle) => (
                    <Button variant="outline" size="sm" className="h-8 gap-1 text-xs" disabled={bulkBusy} onClick={toggle} aria-haspopup="menu" aria-expanded={open} aria-label="Move selected to team">
                      Team <ChevronDown className="size-3.5 text-muted-foreground" />
                    </Button>
                  )}
                >
                  <MenuItem icon={UsersRound} label="No team" onSelect={() => void runBulk("team", null)} />
                  <MenuSeparator />
                  {teams.map((t) => (
                    <MenuItem
                      key={t.id}
                      label={t.name}
                      leading={
                        t.emoji ? (
                          <span className="w-3.5 shrink-0 text-center text-small leading-none">{t.emoji}</span>
                        ) : (
                          <UsersRound className="size-3.5 shrink-0 text-muted-foreground" />
                        )
                      }
                      onSelect={() => void runBulk("team", t.id)}
                    />
                  ))}
                </Menu>
              )}
              <span className="inline-flex items-center gap-1">
                <Input
                  value={tagDraft}
                  onChange={(e) => setTagDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && tagDraft.trim()) void runBulk("tag", tagDraft.trim()); }}
                  placeholder="Add tag…"
                  className="h-8 w-28 text-xs"
                />
                <Button variant="outline" size="icon" className="size-8" disabled={bulkBusy || !tagDraft.trim()} onClick={() => void runBulk("tag", tagDraft.trim())} aria-label="Add tag to selected">
                  <Plus className="size-4" />
                </Button>
              </span>
              <Button variant="ghost" size="sm" className="ml-auto h-8 gap-1 text-xs" onClick={() => setRowSelection({})}>
                <X className="size-3.5" /> Clear
              </Button>
            </div>
          ) : (
            <>
              <h1 className="text-sm font-semibold tracking-tight">Tickets</h1>
              <span className="text-xs tabular-nums text-muted-foreground">{loading && !page_ ? "loading…" : total.toLocaleString()}</span>
              {/* the Conversation/Table switch stays top-LEFT on both renderings —
                  switching views must not teleport the control across the screen */}
              <InboxViewSwitch current="table" />
              <div className="ml-auto flex items-center gap-1.5">
                {/* saved views + save-current, one quiet menu */}
                {showSave ? (
                  <span className="inline-flex items-center gap-1">
                    <Input
                      value={viewName}
                      onChange={(e) => setViewName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveView();
                        if (e.key === "Escape") setShowSave(false);
                      }}
                      placeholder="View name"
                      className="h-8 w-36 text-xs"
                      autoFocus
                    />
                    <Button size="icon" className="size-8" onClick={() => void saveView()} disabled={!viewName.trim()} aria-label="Save view">
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
                        <Bookmark className="size-3.5" /> Views
                        {views.length > 0 && <span className="tabular-nums">{views.length}</span>}
                      </button>
                    )}
                  >
                    {views.length === 0 && (
                      <div className="px-2 py-1.5 text-xs text-muted-foreground">No saved views yet.</div>
                    )}
                    {views.map((v) => (
                      <div key={v.id} className="group flex items-center rounded-md hover:bg-accent">
                        <button
                          type="button"
                          onClick={() => applyView(v)}
                          className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-small"
                        >
                          {v.name}
                        </button>
                        <button
                          type="button"
                          onClick={() => void removeView(v)}
                          aria-label={`Delete view ${v.name}`}
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

                {/* status — the same segmented slot every list surface uses */}
                <div role="tablist" aria-label="Status filter" className="inline-flex items-center gap-0.5 rounded-lg border bg-muted/60 p-0.5">
                  {STATUS_TABS.map((t) => (
                    <button
                      key={t.value}
                      role="tab"
                      aria-selected={status === t.value}
                      onClick={() => setStatus(t.value)}
                      className={cn(TAB_BASE, status === t.value ? TAB_ON : TAB_OFF)}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>

                {/* priority filter — a picker menu, not a chip band */}
                <Menu
                  width={176}
                  trigger={(open, toggle) => (
                    <button
                      type="button"
                      onClick={toggle}
                      aria-haspopup="menu"
                      aria-expanded={open}
                      className={cn(
                        "inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs transition-colors hover:bg-muted/60",
                        priorities.length ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
                        open && "bg-muted/60 text-foreground",
                      )}
                    >
                      <ListFilter className="size-3.5" />
                      {priorities.length ? `Priority · ${priorities.length}` : "Priority"}
                    </button>
                  )}
                >
                  {TICKET_PRIORITIES.map((p) => (
                    <MenuItem
                      key={p}
                      label={PRIORITY_META[p].label}
                      leading={<span className={cn("size-1.5 shrink-0 rounded-full", PRIORITY_META[p].dot)} />}
                      selected={priorities.includes(p)}
                      keepOpen
                      onSelect={() => togglePriority(p)}
                    />
                  ))}
                </Menu>

                {/* team filter — single-select picker, same quiet slot as priority */}
                <Menu
                  width={192}
                  trigger={(open, toggle) => (
                    <button
                      type="button"
                      onClick={toggle}
                      aria-haspopup="menu"
                      aria-expanded={open}
                      className={cn(
                        "inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs transition-colors hover:bg-muted/60",
                        teamFilter ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
                        open && "bg-muted/60 text-foreground",
                      )}
                    >
                      <UsersRound className="size-3.5" />
                      {teamFilter ? `Team · ${teamFilterLabel ?? "…"}` : "Team"}
                    </button>
                  )}
                >
                  <MenuItem label="Any team" selected={!teamFilter} onSelect={() => setTeamFilter(undefined)} />
                  <MenuItem label="No team" selected={teamFilter === "none"} onSelect={() => setTeamFilter("none")} />
                  {teams.length > 0 && <MenuSeparator />}
                  {teams.map((t) => (
                    <MenuItem
                      key={t.id}
                      label={t.name}
                      leading={
                        t.emoji ? (
                          <span className="w-3.5 shrink-0 text-center text-small leading-none">{t.emoji}</span>
                        ) : (
                          <UsersRound className="size-3.5 shrink-0 text-muted-foreground" />
                        )
                      }
                      selected={teamFilter === t.id}
                      onSelect={() => setTeamFilter(t.id)}
                    />
                  ))}
                </Menu>

                {/* assignee filter — single-select picker, same quiet slot as team */}
                <Menu
                  width={208}
                  trigger={(open, toggle) => (
                    <button
                      type="button"
                      onClick={toggle}
                      aria-haspopup="menu"
                      aria-expanded={open}
                      className={cn(
                        "inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs transition-colors hover:bg-muted/60",
                        assigneeFilter ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
                        open && "bg-muted/60 text-foreground",
                      )}
                    >
                      <UserRound className="size-3.5" />
                      {assigneeFilter ? `Assignee · ${assigneeFilterLabel ?? "…"}` : "Assignee"}
                    </button>
                  )}
                >
                  <MenuItem label="Anyone" selected={!assigneeFilter} onSelect={() => setAssigneeFilter(undefined)} />
                  <MenuItem icon={UserRoundX} label="Unassigned" selected={assigneeFilter === "none"} onSelect={() => setAssigneeFilter("none")} />
                  {users.length > 0 && <MenuSeparator />}
                  {users.map((u) => (
                    <MenuItem
                      key={u.id}
                      label={u.name}
                      hint={u.role}
                      leading={<Avatar name={u.name} className="size-4 shrink-0 text-[8px]" />}
                      selected={assigneeFilter === u.id}
                      onSelect={() => setAssigneeFilter(u.id)}
                    />
                  ))}
                </Menu>

                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={rawQ}
                    onChange={(e) => setRawQ(e.target.value)}
                    placeholder="Search subject…"
                    aria-label="Search tickets"
                    className="h-8 w-44 pl-8 text-sm lg:w-56"
                  />
                </div>
                {hasFilters && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    aria-label="Clear filters"
                    title="Clear filters"
                    onClick={() => { setRawQ(""); void navigate({ search: {} }); }}
                  >
                    <X className="size-4" />
                  </Button>
                )}
              </div>
            </>
          )}
        </header>

        {/* table */}
        <div className="min-h-0 flex-1 overflow-auto">
          {loading && !page_ ? (
            <RowsSkeleton rows={8} />
          ) : error ? (
            <ErrorState onRetry={() => setReloadKey((k) => k + 1)} />
          ) : (page_?.tickets.length ?? 0) === 0 ? (
            <EmptyState
              icon={TicketIcon}
              title="No tickets"
              description="Adjust the filters or clear them to see everything."
            />
          ) : (
            <div className={cn("transition-opacity", loading && "opacity-60")}>
              <DataTableRT table={table} onRowClick={(t) => void navigate({ to: "/tickets/$ticketId", params: { ticketId: t.id } })} />
            </div>
          )}
        </div>

        {/* pager */}
        {total > PAGE_SIZE && (
          <div className="flex shrink-0 items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
            </span>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon" className="size-7" disabled={page === 0} onClick={() => gotoPage(page - 1)} aria-label="Previous page">
                <ChevronLeft className="size-4" />
              </Button>
              <span className="px-2 tabular-nums">Page {page + 1} / {pageCount}</span>
              <Button variant="outline" size="icon" className="size-7" disabled={page + 1 >= pageCount} onClick={() => gotoPage(page + 1)} aria-label="Next page">
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
