import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getRouteApi, Link } from "@tanstack/react-router";
import { Search, Inbox as InboxIcon, ArrowDownWideNarrow, MessageCircle } from "lucide-react";
import { useAuth } from "@/auth/auth";
import {
  type Ticket,
  type ViewKey,
  type AgentUser,
  fetchOpenTickets,
  fetchClosedTickets,
  fetchUsers,
  searchTickets,
  filterByView,
  viewCounts,
  fetchUnreadTicketIds,
  markTicketRead,
  bulkTickets,
} from "@/lib/tickets";
import { type Team, fetchTeams } from "@/lib/teams";
import { useRealtime } from "@/lib/realtime-context";
import { useQueue } from "@/lib/queue-context";
import { useNerdMode } from "@/lib/nerd-mode";
import { InboxViewSwitch } from "@/components/inbox/view-switch";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { Menu, MenuItem } from "@/components/ui/menu";
import { NoolaMark } from "@/components/noola-mark";
import { ViewsRail, ViewsChips, VIEWS } from "@/components/inbox/views-rail";
import { TicketRow } from "@/components/inbox/ticket-row";
import { ThreadPane } from "@/components/inbox/thread-pane";
import { cn } from "@/lib/utils";

const EMPTY_COPY: Record<ViewKey, string> = {
  all: "No open tickets. When a customer writes in, it lands here.",
  needs_reply: "You're all caught up — nothing is waiting on a reply.",
  approval: "No AI drafts are waiting for approval.",
  unassigned: "Every open ticket has an owner.",
  my: "Nothing is assigned to you right now.",
  closed: "No closed tickets yet.",
};

const SHORTCUTS: [string[], string][] = [
  [["J", "K"], "Move between conversations"],
  [["↵"], "Open / mark read"],
  [["E"], "Close conversation"],
  [["[", "]"], "Switch view"],
];

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex min-w-5 justify-center rounded border bg-muted px-1.5 py-0.5 font-sans text-micro font-medium leading-none text-muted-foreground">
      {children}
    </kbd>
  );
}

// Triage sort — the operator picks the order that matches how they're working:
// most-recent activity, longest-waiting, by priority, or by SLA urgency.
type SortKey = "recent" | "oldest" | "priority" | "sla";
const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "recent", label: "Newest" },
  { key: "oldest", label: "Oldest waiting" },
  { key: "priority", label: "Priority" },
  { key: "sla", label: "SLA at-risk" },
];
const PRIORITY_RANK: Record<string, number> = { urgent: 3, high: 2, normal: 1, low: 0 };
function slaUrgency(t: Ticket): number {
  const s = t.sla;
  if (!s) return -1;
  const states = [s.firstResponse.state, s.resolution.state];
  if (states.includes("breached")) return 3;
  if (states.includes("at_risk")) return 2;
  return 1;
}
function sortTickets(rows: Ticket[], key: SortKey): Ticket[] {
  const out = [...rows];
  const recent = (a: Ticket, b: Ticket) =>
    new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  switch (key) {
    case "oldest":
      out.sort((a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime());
      break;
    case "priority":
      out.sort(
        (a, b) => (PRIORITY_RANK[b.priority] ?? 0) - (PRIORITY_RANK[a.priority] ?? 0) || recent(a, b),
      );
      break;
    case "sla":
      out.sort((a, b) => slaUrgency(b) - slaUrgency(a) || recent(a, b));
      break;
    default:
      out.sort(recent);
  }
  return out;
}

const inboxRouteApi = getRouteApi("/");

export function InboxPage() {
  const { user } = useAuth();
  const { ticket: selectedId, view: viewParam } = inboxRouteApi.useSearch();
  const navigate = inboxRouteApi.useNavigate();
  const { subscribe } = useRealtime();
  const { nerd } = useNerdMode();
  const [open, setOpen] = useState<Ticket[] | null>(null);
  const [closed, setClosed] = useState<Ticket[]>([]);
  const [users, setUsers] = useState<AgentUser[]>([]);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<ViewKey>(() =>
    VIEWS.some((v) => v.key === viewParam) ? (viewParam as ViewKey) : "all",
  );
  // Team lanes (Teams, Wave 2). A team acts as its own view: selecting one
  // shows that team's open tickets; picking a fixed view clears it (and vice
  // versa). Teams load once, best-effort — [] renders no Teams section at all.
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamId, setTeamId] = useState<string | null>(null);
  const selectView = (v: ViewKey) => {
    setTeamId(null);
    setView(v);
  };
  const selectTeam = (id: string) => setTeamId(id);
  // Per-agent unread set (open tickets with an unseen customer message). Fetched alongside the
  // lists; opening a ticket clears it optimistically and marks it read server-side.
  const [unreadIds, setUnreadIds] = useState<Set<string>>(() => new Set());
  // Selection is URL-tracked (`/?ticket=<id>`) so a conversation is shareable and
  // survives reload — the table and the inbox open the exact same thread surface.
  const select = (id: string | null, opts?: { read?: boolean }) => {
    // Peeking (auto-select, keyboard scan) passes read:false so the unread dot
    // survives until a real open (mouse click / Enter).
    const read = opts?.read ?? true;
    if (id && read) {
      setUnreadIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      void markTicketRead(id).catch(() => {});
    }
    void navigate({ search: (s) => ({ ...s, ticket: id ?? undefined }) });
  };
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Ticket[] | null>(null); // null = not searching
  const [searching, setSearching] = useState(false);
  const [searchMs, setSearchMs] = useState<number | null>(null);
  const [rtSignal, setRtSignal] = useState(0); // bumped to refetch the open thread live
  const [pulseIds, setPulseIds] = useState<Set<string>>(() => new Set()); // tickets with fresh live activity

  async function load() {
    setLoading(true);
    setError(false);
    try {
      const [o, c, u] = await Promise.all([fetchOpenTickets(), fetchClosedTickets(), fetchUsers()]);
      setOpen(o);
      setClosed(c);
      setUsers(u);
      // Unread set is best-effort — never fail the inbox load over it.
      void fetchUnreadTicketIds()
        .then((ids) => setUnreadIds(new Set(ids)))
        .catch(() => {});
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // Teams are best-effort chrome — a failed fetch just hides the section.
    void fetchTeams()
      .then(setTeams)
      .catch(() => setTeams([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep refs fresh so the (tenant-stable) realtime subscription always calls
  // the latest load() and reads the currently-open ticket without re-subscribing.
  const loadRef = useRef(load);
  const selectedRef = useRef(selectedId);
  useEffect(() => {
    loadRef.current = load;
    selectedRef.current = selectedId;
  });

  // Realtime: tap the app-wide event bus. A "new_event" (inbound message, an
  // agent's reply, a status change) refreshes the inbox with no manual poke; if
  // it touches the open ticket, bump the thread to refetch live.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribe((e) => {
      if (timer) clearTimeout(timer); // coalesce bursts into one reload
      timer = setTimeout(() => void loadRef.current(), 250);
      if (e.ticketId && e.ticketId === selectedRef.current) setRtSignal((n) => n + 1);
      // Flash a live pulse dot on the touched row, then let it fade after 2.5s.
      if (e.ticketId) {
        const id = e.ticketId;
        setPulseIds((prev) => new Set(prev).add(id));
        setTimeout(
          () =>
            setPulseIds((prev) => {
              if (!prev.has(id)) return prev;
              const next = new Set(prev);
              next.delete(id);
              return next;
            }),
          2500,
        );
      }
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [subscribe]);

  // Full-text search: debounce the box, then hit the server (subject + body,
  // tenant-scoped, across open+closed). Empty query drops back to the view list.
  // A per-run token discards out-of-order responses.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    let live = true;
    const t = setTimeout(async () => {
      const startedAt = performance.now();
      try {
        const hits = await searchTickets(q);
        if (live) {
          setSearchResults(hits);
          setSearchMs(Math.round(performance.now() - startedAt));
        }
      } catch {
        if (live) setSearchResults([]);
      } finally {
        if (live) setSearching(false);
      }
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query]);

  const myId = user?.id ?? "";
  const { items: queueItems } = useQueue();
  const approvalIds = useMemo(() => new Set(queueItems.map((i) => i.ticket_id)), [queueItems]);
  const counts = useMemo(
    () => viewCounts(open ?? [], closed, myId, approvalIds),
    [open, closed, myId, approvalIds],
  );
  const searchMode = query.trim().length > 0;
  const [sort, setSort] = useState<SortKey>("recent");
  // Live open-ticket count per team lane, straight from the fetched rows.
  const teamCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const t of open ?? []) if (t.team_id) out[t.team_id] = (out[t.team_id] ?? 0) + 1;
    return out;
  }, [open]);
  const activeTeam = useMemo(
    () => (teamId ? (teams.find((t) => t.id === teamId) ?? null) : null),
    [teamId, teams],
  );
  const list = useMemo(() => {
    if (searchMode) return searchResults ?? [];
    if (activeTeam)
      return sortTickets((open ?? []).filter((t) => t.team_id === activeTeam.id), sort);
    return sortTickets(filterByView(view, open ?? [], closed, myId, approvalIds), sort);
  }, [searchMode, searchResults, activeTeam, view, open, closed, myId, sort]);

  const selected = useMemo(
    () => [...(open ?? []), ...closed, ...(searchResults ?? [])].find((t) => t.id === selectedId) ?? null,
    [open, closed, searchResults, selectedId],
  );
  const activeView = VIEWS.find((v) => v.key === view)!;

  // Auto-select the top row on desktop after the first load so the reading pane is
  // productive on arrival — but WITHOUT marking it read (that waits for a real open).
  const autoSelectedRef = useRef(false);
  useEffect(() => {
    if (autoSelectedRef.current || loading || open === null) return;
    autoSelectedRef.current = true;
    if (selectedId) return;
    if (window.matchMedia("(min-width: 768px)").matches && list[0]) {
      select(list[0].id, { read: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, open]);

  // Keyboard-first triage. j/k or ↑/↓ move selection (peek — no mark-read), Enter
  // opens (marks read), e closes / r reopens, [ ] switch views. Bound once; live
  // state is read through a ref so we never re-bind or capture stale values.
  const kbd = useRef({ list, selectedId, view });
  useEffect(() => {
    kbd.current = { list, selectedId, view };
  });
  useEffect(() => {
    const cycleView = (dir: number) => {
      const i = VIEWS.findIndex((v) => v.key === kbd.current.view);
      setTeamId(null); // [ ] walk the fixed views — leaving any team lane
      setView(VIEWS[(i + dir + VIEWS.length) % VIEWS.length].key);
    };
    const bulkThenReload = async (id: string, action: "close" | "reopen") => {
      try {
        await bulkTickets([id], action);
        await loadRef.current();
      } catch {
        /* a failed bulk op must not break keyboard flow */
      }
    };
    const scrollTo = (id: string) =>
      requestAnimationFrame(() =>
        document.querySelector(`[data-ticket-id="${id}"]`)?.scrollIntoView({ block: "nearest" }),
      );
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable)
      )
        return;
      const { list: rows, selectedId: sel, view: v } = kbd.current;
      if (!rows.length && e.key !== "[" && e.key !== "]") return;
      const idx = rows.findIndex((x) => x.id === sel);
      switch (e.key) {
        case "j":
        case "ArrowDown": {
          e.preventDefault();
          const n = rows[idx < 0 ? 0 : Math.min(idx + 1, rows.length - 1)];
          if (n) {
            select(n.id, { read: false });
            scrollTo(n.id);
          }
          break;
        }
        case "k":
        case "ArrowUp": {
          e.preventDefault();
          const p = rows[idx <= 0 ? 0 : idx - 1];
          if (p) {
            select(p.id, { read: false });
            scrollTo(p.id);
          }
          break;
        }
        case "Enter":
          if (sel) {
            e.preventDefault();
            select(sel, { read: true });
          }
          break;
        case "[":
          e.preventDefault();
          cycleView(-1);
          break;
        case "]":
          e.preventDefault();
          cycleView(1);
          break;
        case "e":
          if (sel && v !== "closed") {
            e.preventDefault();
            void bulkThenReload(sel, "close");
          }
          break;
        case "r":
          if (sel && v === "closed") {
            e.preventDefault();
            void bulkThenReload(sel, "reopen");
          }
          break;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      {/* narrow screens: view chips replace the views column */}
      <ViewsChips
        view={view}
        counts={counts}
        onSelect={selectView}
        teams={teams}
        teamCounts={teamCounts}
        activeTeamId={activeTeam?.id ?? null}
        onSelectTeam={selectTeam}
      />

      {/* ── floating panels on the canvas: [inbox: views | list] | thread | rail ── */}
      <div className="flex min-h-0 flex-1 gap-2">
        {/* the ONE inbox panel — views and list share it, divided by a hairline */}
        <div
          className={cn(
            "min-h-0 w-full overflow-hidden rounded-xl border bg-card shadow-sm md:flex md:w-auto md:shrink-0",
            selectedId ? "hidden md:flex" : "flex",
          )}
        >
          <ViewsRail
            view={view}
            counts={counts}
            onSelect={selectView}
            teams={teams}
            teamCounts={teamCounts}
            activeTeamId={activeTeam?.id ?? null}
            onSelectTeam={selectTeam}
          />

          {/* list column — the conversation wins the width budget: narrows at
              xl (where the details rail appears), re-widens on huge screens */}
          <div className="flex min-h-0 w-full flex-col md:w-72 lg:w-80 xl:w-72 2xl:w-80">
          {/* pane header — the STRUCTURE.md h-12 contract */}
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-3">
            <h1 className="text-sm font-semibold tracking-tight">
              {searchMode ? "Search" : (activeTeam?.name ?? activeView.label)}
            </h1>
            <span className="text-xs tabular-nums text-muted-foreground">
              {searching ? "…" : list.length}
              {nerd && searchMode && !searching && searchMs != null && (
                <span className="ml-1 font-mono text-micro text-muted-foreground/70">· {searchMs}ms</span>
              )}
            </span>
            <span className="ml-auto flex items-center gap-1">
              {!searchMode && (
                <Menu
                  align="end"
                  width={176}
                  trigger={(menuOpen, toggle) => (
                    <button
                      type="button"
                      onClick={toggle}
                      aria-label="Sort conversations"
                      aria-expanded={menuOpen}
                      className={cn(
                        "flex h-7 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
                        menuOpen && "bg-muted/60 text-foreground",
                      )}
                    >
                      <ArrowDownWideNarrow className="size-3.5" />
                      <span className="hidden lg:inline">
                        {SORT_OPTIONS.find((o) => o.key === sort)!.label}
                      </span>
                    </button>
                  )}
                >
                  {SORT_OPTIONS.map((o) => (
                    <MenuItem
                      key={o.key}
                      label={o.label}
                      selected={o.key === sort}
                      onSelect={() => setSort(o.key)}
                    />
                  ))}
                </Menu>
              )}
              <InboxViewSwitch current="conversation" />
            </span>
          </header>
          <div className="shrink-0 px-3 py-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search tickets…"
                className="h-8 border-none bg-muted/60 pl-8 shadow-none focus-visible:ring-1"
                aria-label="Search tickets"
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading && open === null ? (
              <RowsSkeleton rows={8} />
            ) : error ? (
              <ErrorState
                title="Couldn't load the inbox"
                description="We couldn't reach the ticket service. Check your connection and try again."
                onRetry={() => void load()}
                retrying={loading}
              />
            ) : searchMode && searching && list.length === 0 ? (
              <div className="grid h-full place-items-center py-10">
                <Spinner />
              </div>
            ) : list.length === 0 ? (
              query.trim() ? (
                <EmptyState
                  icon={Search}
                  title="No matching tickets"
                  description={`Nothing matches “${query.trim()}”.`}
                />
              ) : (
                <EmptyState
                  icon={InboxIcon}
                  title="No conversations here"
                  description={
                    activeTeam
                      ? `Nothing open in ${activeTeam.name}'s lane right now.`
                      : EMPTY_COPY[view]
                  }
                  action={
                    // First-run path to the one channel that works with zero external creds:
                    // create a widget key, paste the embed, and the first ticket arrives.
                    !activeTeam && view === "all" ? (
                      <Link
                        to="/settings/messenger"
                        className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted/60"
                      >
                        <MessageCircle className="size-3.5" /> Set up the messenger widget
                      </Link>
                    ) : undefined
                  }
                />
              )
            ) : (
              <ul>
                {list.map((t) => (
                  <li key={t.id} data-ticket-id={t.id}>
                    <TicketRow
                      ticket={t}
                      selected={t.id === selectedId}
                      onClick={() => select(t.id)}
                      nerd={nerd}
                      pulsing={pulseIds.has(t.id)}
                      unread={unreadIds.has(t.id)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
          </div>
        </div>

        {/* thread column */}
        <div className={cn("min-w-0 flex-1", selectedId ? "flex" : "hidden md:flex")}>
          {selected ? (
            <ThreadPane
              ticket={selected}
              users={users}
              refreshKey={rtSignal}
              onBack={() => select(null)}
              onMutated={() => void load()}
            />
          ) : (
            <div className="grid flex-1 place-items-center rounded-xl border bg-card p-8 shadow-sm">
              <div className="flex max-w-xs flex-col items-center gap-4 text-center">
                <NoolaMark className="opacity-40" />
                <p className="text-sm text-muted-foreground">
                  Select a conversation to read the full thread.
                </p>
                <dl className="hidden grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-left text-xs text-muted-foreground md:grid">
                  {SHORTCUTS.map(([keys, label]) => (
                    <Fragment key={label}>
                      <dt className="flex justify-end gap-1">
                        {keys.map((k) => (
                          <Kbd key={k}>{k}</Kbd>
                        ))}
                      </dt>
                      <dd>{label}</dd>
                    </Fragment>
                  ))}
                </dl>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
