import { useEffect, useRef, useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, ListFilter, ScanSearch, Search, ShieldAlert, X } from "lucide-react";
import { useAuth } from "@/auth/auth";
import { fetchTraces, TRACE_CATEGORIES, TRACE_PAGE_SIZE, type TraceCategory, type TraceListRow } from "@/lib/traces";
import type { ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Menu, MenuItem } from "@/components/ui/menu";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { TraceList } from "@/components/inbox/trace-list";
import { TraceDialog } from "@/components/inbox/trace-dialog";
import { cn } from "@/lib/utils";

// Every AI trace in the workspace, newest first, for admins and owners. Filters and the page live in the URL.

const routeApi = getRouteApi("/ai-traces");

/** Local midnight of a calendar day, `plusDays` later, as an ISO instant. */
function dayStart(day: string | undefined, plusDays = 0): string | undefined {
  if (!day) return undefined;
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d + plusDays).toISOString();
}

export function AiTracesPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin" || user?.role === "owner";
  const search = routeApi.useSearch();
  const navigate = routeApi.useNavigate();
  const page = search.page ?? 1;

  const [rawQ, setRawQ] = useState(search.q ?? "");
  const [result, setResult] = useState<{ traces: TraceListRow[]; total: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<"forbidden" | "failed" | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [openTrace, setOpenTrace] = useState<string | null>(null);

  // Debounce the free-text search into the URL (which drives the fetch).
  const qTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (qTimer.current) clearTimeout(qTimer.current);
    qTimer.current = setTimeout(() => {
      const next = rawQ.trim() || undefined;
      if (next !== (search.q ?? undefined)) void navigate({ search: (s) => ({ ...s, q: next, page: undefined }) });
    }, 300);
    return () => { if (qTimer.current) clearTimeout(qTimer.current); };
  }, [rawQ]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isAdmin) return;
    let live = true;
    setLoading(true);
    setError(null);
    fetchTraces({ page, outcome: search.outcome, q: search.q, from: dayStart(search.from), to: dayStart(search.to, 1) })
      .then((r) => {
        if (!live) return;
        setResult(r);
        // A link to a page past the end, such as an old bookmark after retention, lands on the last page.
        const last = Math.max(1, Math.ceil(r.total / TRACE_PAGE_SIZE));
        if (r.traces.length === 0 && r.total > 0 && page > last) {
          void navigate({ search: (s) => ({ ...s, page: last > 1 ? last : undefined }), replace: true });
        }
      })
      .catch((e: ApiError) => { if (live) setError(e.status === 403 ? "forbidden" : "failed"); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [isAdmin, page, search.outcome, search.q, search.from, search.to, reloadKey]);

  const total = result?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / TRACE_PAGE_SIZE));
  const hasFilters = !!search.outcome || !!search.q || !!search.from || !!search.to;
  const outcomeLabel = TRACE_CATEGORIES.find((c) => c.value === search.outcome)?.label;
  const setOutcome = (outcome: TraceCategory | undefined) => void navigate({ search: (s) => ({ ...s, outcome, page: undefined }) });
  const setDay = (key: "from" | "to", value: string) =>
    void navigate({ search: (s) => ({ ...s, [key]: value || undefined, page: undefined }) });
  const gotoPage = (n: number) => void navigate({ search: (s) => ({ ...s, page: Math.max(1, Math.min(n, pageCount)) }) });

  if (!isAdmin || error === "forbidden") {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="Admins only"
        description="AI traces hold customer text and the model's raw output, so only admins and owners can open them."
      />
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 px-4 py-2">
        <h1 className="text-sm font-semibold tracking-tight">AI traces</h1>
        <span className="text-xs tabular-nums text-muted-foreground">{loading && !result ? "loading…" : total.toLocaleString()}</span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Menu
            width={224}
            trigger={(open, toggle) => (
              <button
                type="button"
                onClick={toggle}
                aria-haspopup="menu"
                aria-expanded={open}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs transition-colors hover:bg-muted/60",
                  search.outcome ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
                  open && "bg-muted/60 text-foreground",
                )}
              >
                <ListFilter className="size-3.5" />
                {outcomeLabel ? `Noola · ${outcomeLabel}` : "What Noola did"}
              </button>
            )}
          >
            <MenuItem label="Anything" selected={!search.outcome} onSelect={() => setOutcome(undefined)} />
            {TRACE_CATEGORIES.map((c) => (
              <MenuItem key={c.value} label={c.label} selected={search.outcome === c.value} onSelect={() => setOutcome(c.value)} />
            ))}
          </Menu>
          <Input
            type="date"
            value={search.from ?? ""}
            max={search.to}
            onChange={(e) => setDay("from", e.target.value)}
            aria-label="From day"
            className="h-8 w-36 text-xs"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <Input
            type="date"
            value={search.to ?? ""}
            min={search.from}
            onChange={(e) => setDay("to", e.target.value)}
            aria-label="To day"
            className="h-8 w-36 text-xs"
          />
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={rawQ}
              onChange={(e) => setRawQ(e.target.value)}
              placeholder="Search customer text…"
              maxLength={200}
              aria-label="Search customer text"
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
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && !result ? (
          <RowsSkeleton rows={8} />
        ) : error ? (
          <ErrorState onRetry={() => setReloadKey((k) => k + 1)} />
        ) : result && result.traces.length > 0 ? (
          <div className={cn("transition-opacity", loading && "opacity-60")}>
            <TraceList traces={result.traces} onOpen={setOpenTrace} />
          </div>
        ) : (
          <EmptyState
            icon={ScanSearch}
            title="No traces"
            description={hasFilters ? "Adjust the filters or clear them to see everything." : "The AI has not drafted anything yet."}
          />
        )}
      </div>

      {total > TRACE_PAGE_SIZE && (
        <div className="flex shrink-0 items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {(page - 1) * TRACE_PAGE_SIZE + 1}–{Math.min(page * TRACE_PAGE_SIZE, total)} of {total}
          </span>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon" className="size-7" disabled={page <= 1} onClick={() => gotoPage(page - 1)} aria-label="Previous page">
              <ChevronLeft className="size-4" />
            </Button>
            <span className="px-2 tabular-nums">Page {page} of {pageCount}</span>
            <Button variant="outline" size="icon" className="size-7" disabled={page >= pageCount} onClick={() => gotoPage(page + 1)} aria-label="Next page">
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}

      {openTrace && <TraceDialog traceId={openTrace} onClose={() => setOpenTrace(null)} />}
    </div>
  );
}
