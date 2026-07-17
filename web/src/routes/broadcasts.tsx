import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, getRouteApi, useNavigate } from "@tanstack/react-router";
import {
  Users,
  Megaphone,
  Send,
  Plus,
  SlidersHorizontal,
  X,
  AlertTriangle,
  Loader2,
  ChevronLeft,
  Eye,
  EyeOff,
  Pencil,
  User,
  Mail,
  MailX,
  Building2,
  Tag,
  CalendarDays,
  CalendarClock,
  Clock,
  Play,
  Square,
  Activity,
  Target,
  Copy,
} from "lucide-react";
import {
  useReactTable,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  createColumnHelper,
  type ColumnDef,
  type SortingState,
  type ColumnFiltersState,
} from "@tanstack/react-table";
import {
  type Broadcast,
  type BroadcastChannel,
  type BroadcastChatPreview,
  type BroadcastStats,
  type BroadcastStatus,
  type Recipient,
  type Segment,
  type SegmentCondition,
  type SegmentPreview,
  fetchBroadcasts,
  fetchBroadcast,
  previewSegment,
  previewBroadcastRender,
  sendBroadcastTest,
  createBroadcast,
  updateBroadcast,
  isBroadcastsUnavailable,
} from "@/lib/broadcasts";
import { type ChannelStatus, fetchChannels } from "@/lib/settings";
import { type EmailTemplate, fetchEmailTemplates } from "@/lib/email-templates";
import { type Segment as SavedSegment, fetchSegments } from "@/lib/segments";
import { SUBSCRIPTION_OP_LABEL, fetchContacts } from "@/lib/contacts";
import { FilterBuilder, type BuilderFieldDef } from "@/components/data-table/filter-builder";
import {
  type FilterCondition,
  type FilterOp,
  EVENT_OP_LABEL,
  OP_LABEL,
  joinFilterGroups,
  splitFilterGroups,
} from "@/components/data-table/types";
import { DataTableRT } from "@/components/data-table/data-table-rt";
import { DataTableToolbar, ResultCount, type FacetConfig } from "@/components/data-table/data-table-toolbar";
import { DataTableEmpty } from "@/components/data-table/states";
import { StatePill, MetricDrillCell, DateCell, type PillTone } from "@/components/data-table/cells";
import { SegmentBar } from "@/components/data-table/segment-bar";
import { type SegmentDefinition } from "@/lib/segments";
import { Badge } from "@/components/ui/badge";
import { ChannelIcon } from "@/components/inbox/badges";
import { ChatPreview } from "@/components/broadcasts/chat-preview";
import {
  BlockComposer,
  type EditorBlock,
  newTextBlock,
  textFromBlocks,
  cleanBlocks,
  blockIssue,
  previewableBlocks,
} from "@/components/broadcasts/block-composer";
import { EmailPreview } from "@/components/email-preview";
import type { ApiError } from "@/lib/api";
import { relativeTime } from "@/lib/tickets";
import { toast } from "@/components/ui/toaster";
import { Button, buttonVariants } from "@/components/ui/button";
import { ArticleBody } from "@/components/editor/article-body";
import { FactRow, RailSection } from "@/components/ui/rail";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { PopoverSelect } from "@/components/ui/menu";
import { TAB_BASE, TAB_OFF, TAB_ON } from "@/components/ui/segmented";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { useRealtime } from "@/lib/realtime-context";
import { cn } from "@/lib/utils";

type LoadState = "ok" | "error" | "unavailable";

// Poll interval while any broadcast is mid-send — the sent/failed tallies climb
// live without a manual refresh even if no realtime event lands.
const SEND_POLL_MS = 2500;
// Gentler poll for a continuous ("active") broadcast on its detail page — the
// worker matches new contacts on a ~30s tick, so its tallies move slowly.
const ACTIVE_POLL_MS = 15000;
// Debounce for the live reach preview as the segment filters are typed.
const PREVIEW_DEBOUNCE_MS = 400;
// Debounce for the rendered-email preview as blocks/subject/template change —
// a touch slower than the reach preview since each render is a full document.
const RENDER_DEBOUNCE_MS = 500;

// ── status — dot + quiet text, never a chip (§4). Failure earns warm red;
// a live continuous broadcast earns the emerald live-dot (the Studio idiom);
// everything else stays muted. ──
const STATUS_LABEL: Record<BroadcastStatus, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  sending: "Sending",
  active: "Continuous",
  sent: "Sent",
  failed: "Failed",
  stopped: "Stopped",
};

function StatusText({ status }: { status: BroadcastStatus }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-xs font-medium",
        status === "failed"
          ? "text-destructive"
          : status === "active"
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-muted-foreground",
      )}
    >
      {status === "sending" ? (
        <Loader2 className="size-3 animate-spin motion-reduce:animate-none" />
      ) : (
        <span
          className={cn(
            "size-1.5 rounded-full",
            status === "failed"
              ? "bg-destructive"
              : status === "active"
                ? "bg-emerald-500"
                : "bg-muted-foreground/50",
          )}
        />
      )}
      {STATUS_LABEL[status]}
    </span>
  );
}

// ── delivery-time words ───────────────────────────────────────────────────────
// "in 2h" — the future mirror of relativeTime (lib/tickets.ts), for scheduled
// send times shown where rows show dates.
function inWords(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.floor((then - Date.now()) / 1000);
  if (s <= 45) return "any moment";
  const m = Math.floor(s / 60);
  if (m < 60) return `in ${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `in ${d}d`;
  const w = Math.floor(d / 7);
  if (w < 5) return `in ${w}w`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `in ${mo}mo`;
  return `in ${Math.floor(d / 365)}y`;
}

/** "Mon, Jul 13, 3:00 PM" — a scheduled time in the operator's own locale and
 *  timezone. Shared with the routed detail page's toasts. */
export function sendTimeWords(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

// ── send window — weekday pills + minute-of-day bounds, shared by the compose
// disclosure and the detail facts. ISO weekday order (1=Mon…7=Sun). ──
const ISO_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** minutes-past-midnight ⇄ "HH:MM" for the window time inputs — the SLA
 *  business-hours idiom (settings-sla.tsx). */
function minToTime(m: number): string {
  const h = Math.floor(m / 60),
    mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}
function timeToMin(v: string): number {
  const [h, m] = v.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** "UTC+2" / "UTC−5:30" / "UTC" — the window's fixed offset, compactly. */
function tzOffsetWords(min: number): string {
  if (min === 0) return "UTC";
  const abs = Math.abs(min);
  const h = Math.floor(abs / 60),
    m = abs % 60;
  return `UTC${min > 0 ? "+" : "−"}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

/** "Mon–Fri · 09:00–17:00 · UTC+2" — a broadcast row's window as one compact
 *  line (null when the row has no window). Consecutive days compact to a
 *  range; scattered days list out. */
function windowWords(b: Broadcast): string | null {
  const days = b.window_days ?? [];
  const hasTime = b.window_start_min != null && b.window_end_min != null;
  if (days.length === 0 && !hasTime) return null;
  const parts: string[] = [];
  if (days.length > 0 && days.length < 7) {
    const sorted = [...new Set(days)].sort((a, c) => a - c);
    const consecutive = sorted.every((v, i) => i === 0 || v === sorted[i - 1] + 1);
    parts.push(
      consecutive && sorted.length > 2
        ? `${ISO_WEEKDAYS[sorted[0] - 1]}–${ISO_WEEKDAYS[sorted[sorted.length - 1] - 1]}`
        : sorted.map((v) => ISO_WEEKDAYS[v - 1]).join(", "),
    );
  } else if (days.length === 7) {
    parts.push("Every day");
  }
  if (hasTime) parts.push(`${minToTime(b.window_start_min!)}–${minToTime(b.window_end_min!)}`);
  parts.push(tzOffsetWords(b.window_tz_offset_min ?? 0));
  return parts.join(" · ");
}

// ── delivery channel — labels + the creds each stub channel needs ────────────
const CHANNEL_LABEL: Record<BroadcastChannel, string> = {
  email: "Email",
  discord: "Discord",
  slack: "Slack",
  telegram: "Telegram",
  whatsapp: "WhatsApp",
};
const BROADCAST_CHANNELS = Object.keys(CHANNEL_LABEL) as BroadcastChannel[];

// Why a channel is disabled — mirrors the server's channel registry gating.
const CHANNEL_CRED_HINT: Record<BroadcastChannel, string> = {
  email: "",
  discord: "Set DISCORD_BOT_TOKEN to enable",
  slack: "Connect a Slack workspace to enable",
  telegram: "Set TELEGRAM_BOT_TOKEN to enable",
  whatsapp: "Set WHATSAPP_TOKEN and WHATSAPP_PHONE_ID to enable",
};

// Built-in template ids always resolve to a name even before (or without) the
// templates list — the raw id is the last-resort fallback.
const BUILTIN_TEMPLATE_NAME: Record<string, string> = {
  branded: "Branded",
  personal: "Personal",
};

function templateName(id: string, templates: EmailTemplate[] | null): string {
  return templates?.find((t) => t.id === id)?.name ?? BUILTIN_TEMPLATE_NAME[id] ?? id;
}

// Display names for the core columns a condition can target — mirrors the
// filter-builder field defs so a sent broadcast's targeting reads the same way
// it was composed.
const CORE_FIELD_LABEL: Record<string, string> = {
  name: "Name",
  email: "Email",
  company: "Company",
  created_at: "Created",
  updated_at: "Last activity",
  unsubscribed_at: "Subscription",
};

// One condition as a labeled clause. Attribute fields read by their key, event
// fields as "Event · logged_in · has done it" — the same phrasing the builder
// chips use.
function conditionClause(c: SegmentCondition): { label: string; value: string } {
  if (c.field.startsWith("event:")) {
    const opText = EVENT_OP_LABEL[c.op] ?? c.op;
    const val = c.value?.trim() ? ` “${c.value.trim()}”` : "";
    return { label: "Event", value: `${c.field.slice(6)} · ${opText}${val}` };
  }
  const label = c.field.startsWith("attr:") ? c.field.slice(5) : CORE_FIELD_LABEL[c.field] ?? c.field;
  const opText =
    (c.field === "unsubscribed_at" ? SUBSCRIPTION_OP_LABEL[c.op] : undefined) ??
    OP_LABEL[c.op as FilterOp] ??
    c.op;
  return { label, value: c.value?.trim() ? `${opText} “${c.value.trim()}”` : opText };
}

// A segment's targeting broken into labeled clauses — rendered as label/value fact
// rows, never as a raw query token (which surfaced a bare search string as gibberish).
// Handles all three grammars: the flat q/company/attr fields (older broadcasts), the
// contacts-directory `conditions`, and OR-ed `conditionGroups` (each group compacts
// to one "Any of"/"or" row whose conditions join with "and").
function segmentClauses(s: Segment): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  if (s.q?.trim()) out.push({ label: "Matches", value: s.q.trim() });
  if (s.company?.trim()) out.push({ label: "Company", value: s.company.trim() });
  if (s.attrKey?.trim()) out.push({ label: s.attrKey.trim(), value: s.attrValue?.trim() || "any value" });
  for (const c of s.conditions ?? []) out.push(conditionClause(c));
  const groups = (s.conditionGroups ?? []).filter((g) => g.length > 0);
  groups.forEach((g, i) => {
    const text = g
      .map((c) => {
        const cl = conditionClause(c);
        return `${cl.label} ${cl.value}`;
      })
      .join(" and ");
    out.push({ label: i === 0 ? "Any of" : "or", value: text });
  });
  return out;
}

const listRouteApi = getRouteApi("/broadcasts");

// ── Broadcasts table (UX diagnosis §4f row 2) ────────────────────────────────
// The hand-rolled list rebuilt on the shared DataTableRT so a marketer can answer "which send
// worked?" from the list itself — State, reach (recipients/sent), engagement (opened%/clicked%),
// Goal, and Sent — with per-row Duplicate to reuse a winner without recomposing from blank.

const STATUS_TONE: Record<BroadcastStatus, PillTone> = {
  draft: "draft",
  scheduled: "info",
  sending: "warning",
  active: "success",
  sent: "success",
  failed: "danger",
  stopped: "neutral",
};

const bcolHelp = createColumnHelper<Broadcast>();

function BroadcastRowActions({ b, onEdit, onDuplicate }: { b: Broadcast; onEdit: (b: Broadcast) => void; onDuplicate: (b: Broadcast) => void }) {
  return (
    <div className="flex items-center justify-end gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
      <Button type="button" variant="ghost" size="icon" className="size-7 text-muted-foreground" title="Duplicate" aria-label="Duplicate broadcast" onClick={(e) => { e.stopPropagation(); onDuplicate(b); }}>
        <Copy className="size-3.5" />
      </Button>
      {b.status === "draft" && (
        <Button type="button" variant="ghost" size="icon" className="size-7 text-muted-foreground" title="Edit draft" aria-label="Edit draft" onClick={(e) => { e.stopPropagation(); onEdit(b); }}>
          <Pencil className="size-3.5" />
        </Button>
      )}
    </div>
  );
}

function buildBroadcastColumns(onEdit: (b: Broadcast) => void, onDuplicate: (b: Broadcast) => void): ColumnDef<Broadcast, any>[] {
  const rate = (n: number | undefined, sent: number) => (sent > 0 ? `${Math.round((100 * (n ?? 0)) / sent)}%` : "—");
  return [
    bcolHelp.accessor("subject", {
      header: "Broadcast",
      meta: { label: "Broadcast" },
      cell: ({ row }) => {
        const b = row.original;
        return (
          <span className="flex min-w-0 items-center gap-2">
            <ChannelIcon channel={b.channel} />
            <span className="min-w-0 truncate font-medium text-foreground">{b.subject || "(no subject)"}</span>
          </span>
        );
      },
    }),
    bcolHelp.accessor("status", {
      header: "State",
      meta: { label: "State" },
      enableSorting: false,
      filterFn: (row, id, val: string[]) => !val?.length || val.includes(row.getValue(id)),
      cell: ({ row }) => <StatePill label={STATUS_LABEL[row.original.status]} tone={STATUS_TONE[row.original.status]} />,
    }),
    bcolHelp.accessor("recipient_count", {
      header: "Recipients",
      meta: { label: "Recipients", align: "right" },
      cell: ({ row }) => <MetricDrillCell value={row.original.recipient_count} to="/broadcasts/$broadcastId" params={{ broadcastId: row.original.id }} />,
    }),
    bcolHelp.accessor("sent_count", {
      header: "Sent",
      meta: { label: "Sent", align: "right" },
      cell: ({ row }) => <MetricDrillCell value={row.original.sent_count} to="/broadcasts/$broadcastId" params={{ broadcastId: row.original.id }} />,
    }),
    bcolHelp.accessor((b) => b.opened ?? 0, {
      id: "opened",
      header: "Opened",
      meta: { label: "Opened", align: "right" },
      cell: ({ row }) => {
        const b = row.original;
        return <span className="tabular-nums text-muted-foreground" title={`${(b.opened ?? 0).toLocaleString()} opened`}>{rate(b.opened, b.sent_count)}</span>;
      },
    }),
    bcolHelp.accessor((b) => b.clicked ?? 0, {
      id: "clicked",
      header: "Clicked",
      meta: { label: "Clicked", align: "right" },
      cell: ({ row }) => {
        const b = row.original;
        return <span className="tabular-nums text-muted-foreground" title={`${(b.clicked ?? 0).toLocaleString()} clicked`}>{rate(b.clicked, b.sent_count)}</span>;
      },
    }),
    bcolHelp.display({
      id: "goal",
      header: "Goal",
      meta: { label: "Goal" },
      cell: ({ row }) =>
        row.original.goal_event ? (
          <Badge variant="muted" className="max-w-[9rem] truncate font-normal">{row.original.goal_event}</Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    }),
    bcolHelp.accessor((b) => new Date(b.sent_at || b.created_at).getTime(), {
      id: "when",
      header: "Sent",
      meta: { label: "Sent" },
      cell: ({ row }) => {
        const b = row.original;
        if (b.status === "scheduled" && b.send_at)
          return <span className="tabular-nums text-muted-foreground" title={new Date(b.send_at).toLocaleString()}>sends {inWords(b.send_at)}</span>;
        return <DateCell iso={b.status === "draft" && !b.sent_at ? null : b.sent_at || b.created_at} />;
      },
    }),
    bcolHelp.display({
      id: "actions",
      header: "",
      enableHiding: false,
      cell: ({ row }) => <BroadcastRowActions b={row.original} onEdit={onEdit} onDuplicate={onDuplicate} />,
    }),
  ];
}

const BROADCAST_STATE_FACET: FacetConfig = {
  columnId: "status",
  label: "State",
  icon: Activity,
  staticOptions: (["draft", "scheduled", "sending", "active", "sent", "failed", "stopped"] as BroadcastStatus[]).map((s) => ({ value: s, label: STATUS_LABEL[s] })),
};

function BroadcastsTable({
  broadcasts,
  onOpen,
  onEdit,
  onDuplicate,
  onCompose,
}: {
  broadcasts: Broadcast[];
  onOpen: (b: Broadcast) => void;
  onEdit: (b: Broadcast) => void;
  onDuplicate: (b: Broadcast) => void;
  onCompose: () => void;
}) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "when", desc: true }]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] = useState({});
  const columns = useMemo(() => buildBroadcastColumns(onEdit, onDuplicate), [onEdit, onDuplicate]);
  const table = useReactTable({
    data: broadcasts,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    getRowId: (b) => b.id,
    state: { sorting, globalFilter, columnFilters, columnVisibility },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    globalFilterFn: (row, _id, value: string) => (row.original.subject || "").toLowerCase().includes(String(value).toLowerCase()),
  });
  const rows = table.getRowModel().rows;
  const isFiltered = globalFilter.trim().length > 0 || columnFilters.length > 0;

  // Saved views on the ONE switcher (segments store, resource=broadcasts) — q + sort persist.
  const definition: SegmentDefinition = useMemo(
    () => ({ q: globalFilter || undefined, sortBy: sorting[0]?.id, sortDir: sorting[0]?.desc ? "desc" : "asc" }),
    [globalFilter, sorting],
  );
  const applyDefinition = (def: SegmentDefinition) => {
    setGlobalFilter(def.q ?? "");
    if (def.sortBy) setSorting([{ id: def.sortBy, desc: def.sortDir !== "asc" }]);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
        <ResultCount count={rows.length} noun="broadcasts" />
        <SegmentBar resource="broadcasts" definition={definition} onApply={applyDefinition} />
        <div className="ml-auto">
          <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={onCompose}>
            <Plus className="size-3.5" /> New broadcast
          </Button>
        </div>
      </div>
      <div className="px-4 pb-2">
        <DataTableToolbar
          table={table}
          search={globalFilter}
          onSearchChange={setGlobalFilter}
          facets={[BROADCAST_STATE_FACET]}
          searchPlaceholder="Search broadcasts…"
        />
      </div>
      {rows.length === 0 ? (
        <DataTableEmpty
          isFiltered={isFiltered}
          onClearFilters={() => {
            setGlobalFilter("");
            table.resetColumnFilters();
          }}
          icon={Megaphone}
          title="No broadcasts yet"
          description="Compose one and target a contact segment."
          action={
            <Button size="sm" className="gap-1" onClick={onCompose}>
              <Plus className="size-3.5" /> New broadcast
            </Button>
          }
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <DataTableRT table={table} onRowClick={onOpen} />
        </div>
      )}
    </div>
  );
}

export function BroadcastsPage() {
  const { subscribe } = useRealtime();
  const navigate = useNavigate();
  // ?edit=<id> — the detail page's Edit click-through lands here and opens the
  // composer seeded from that draft once the list has loaded.
  const { edit: editParam } = listRouteApi.useSearch();

  const [broadcasts, setBroadcasts] = useState<Broadcast[] | null>(null);
  const [state, setState] = useState<LoadState>("ok");
  const [composing, setComposing] = useState(false);
  // The draft being re-edited (null = composing a NEW broadcast).
  const [editing, setEditing] = useState<Broadcast | null>(null);

  const load = useRef(async () => {
    try {
      setBroadcasts(await fetchBroadcasts());
      setState("ok");
    } catch (e) {
      setState(isBroadcastsUnavailable(e) ? "unavailable" : "error");
    }
  }).current;

  useEffect(() => {
    void load();
  }, [load]);

  // Live: a broadcast progressing (noola.broadcast.updated) or another agent
  // composing one refreshes the list. Debounced to coalesce bursts.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribe(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 400);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [subscribe, load]);

  // While any broadcast is mid-send, poll so the tallies climb live.
  const anySending = (broadcasts ?? []).some((b) => b.status === "sending");
  useEffect(() => {
    if (!anySending) return;
    const t = setInterval(() => void load(), SEND_POLL_MS);
    return () => clearInterval(t);
  }, [anySending, load]);

  function openCompose() {
    setEditing(null);
    setComposing(true);
  }

  function openEdit(b: Broadcast) {
    setEditing(b);
    setComposing(true);
  }

  // Duplicate → a fresh draft cloned from the source (subject/body/blocks/segment/channel/goal/
  // window). Lets a marketer reuse last week's winner without recomposing from blank (UX t3/t4).
  async function duplicate(b: Broadcast) {
    try {
      await createBroadcast({
        subject: b.subject ? `${b.subject} (copy)` : "(copy)",
        body: b.body ?? "",
        blocks: b.blocks ?? undefined,
        segment: b.segment,
        channel: b.channel,
        // Carry a channel-post's target + options so a duplicated Discord broadcast is complete.
        ...(b.audience_kind === "discord_channel"
          ? { audienceKind: "discord_channel" as const, targetRef: b.target_ref ?? "", mentionRoleId: b.mention_role_id ?? null, asEmbed: b.as_embed ?? false }
          : {}),
        templateId: b.template_id ?? undefined,
        mode: b.mode,
        goalEvent: b.goal_event ?? undefined,
        goalDays: b.goal_days,
        windowDays: b.window_days ?? undefined,
        windowStartMin: b.window_start_min ?? undefined,
        windowEndMin: b.window_end_min ?? undefined,
        windowTzOffsetMin: b.window_tz_offset_min ?? undefined,
      });
      toast.success("Duplicated — review the draft, then send.");
      await load();
    } catch {
      toast.error("Couldn't duplicate broadcast.");
    }
  }

  // The ?edit=<id> click-through (detail header → composer): once the list is
  // in, open the composer on that draft and drop the param from the URL. A
  // non-draft (raced into another status) just explains itself.
  useEffect(() => {
    if (!editParam || broadcasts === null) return;
    const target = broadcasts.find((b) => b.id === editParam);
    if (target?.status === "draft") {
      setEditing(target);
      setComposing(true);
    } else if (target) {
      toast.error("Only drafts can be edited.");
    }
    void navigate({ to: "/broadcasts", search: {}, replace: true });
  }, [editParam, broadcasts, navigate]);

  // A fresh draft opens on its own routed page so Send is one click away.
  // The toast's verb matches the delivery plan the draft carries.
  function handleSaved(b: Broadcast, updated: boolean) {
    setComposing(false);
    setEditing(null);
    toast.success(
      updated
        ? "Draft updated."
        : b.mode === "continuous"
          ? "Draft created — review, then start it."
          : b.send_at
            ? "Draft created — review, then arm the schedule."
            : "Draft created — review, then send.",
    );
    void navigate({ to: "/broadcasts/$broadcastId", params: { broadcastId: b.id } });
  }

  // Compose fully replaces the surface; otherwise the list runs full-width.
  if (composing) {
    return (
      <>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ComposeBroadcast
            key={editing?.id ?? "new"}
            draft={editing}
            onCancel={() => {
              setComposing(false);
              setEditing(null);
            }}
            onSaved={handleSaved}
            onError={(msg) => toast.error(msg)}
          />
        </div>
      </>
    );
  }

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        {/* ── pane header (h-12, §3) ─────────────────────────────────────── */}
        <header className="flex h-12 shrink-0 items-center gap-2 px-4">
          <h1 className="text-sm font-semibold tracking-tight">Broadcasts</h1>
        </header>

        {state === "unavailable" ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
              <Megaphone className="size-6 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">
                Broadcasts aren't available on this server yet.
              </p>
            </div>
          ) : broadcasts === null && state === "ok" ? (
            <RowsSkeleton rows={6} />
          ) : state === "error" ? (
            <ErrorState description="Couldn't load broadcasts." onRetry={() => void load()} />
          ) : (
            <BroadcastsTable
              broadcasts={broadcasts ?? []}
              onOpen={(b) => void navigate({ to: "/broadcasts/$broadcastId", params: { broadcastId: b.id } })}
              onEdit={openEdit}
              onDuplicate={(b) => void duplicate(b)}
              onCompose={openCompose}
            />
          )}
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Compose — subject, body, and a segment builder with a live reach preview.
// With `draft` set it's the same form seeded from an existing draft, and saving
// PATCHes it instead of creating a new one. Callers remount per draft (key on
// the id) so the lazy initializers below are enough seeding.
// ─────────────────────────────────────────────────────────────────────────────

/** ISO → the timezone-naive `datetime-local` value, in LOCAL wall time (the
 *  mirror of the submit-time `new Date(local).toISOString()`). */
function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The block editor seeded from a draft: its stored blocks (fresh client ids),
 *  or its markdown body as one text block (an older email draft, or a chat
 *  draft the operator might switch to email), or the usual empty text block. */
function seedBlocks(draft: Broadcast | null): EditorBlock[] {
  if (draft?.blocks?.length) return draft.blocks.map((b) => ({ ...b, id: crypto.randomUUID() }));
  if (draft?.body?.trim()) return [{ id: crypto.randomUUID(), type: "text", md: draft.body }];
  return [newTextBlock()];
}

/** The filter builder seeded from a draft's segment — conditions revived with
 *  fresh client ids (ids never round-trip), legacy flat company/attr fields
 *  folded into equivalent conditions, OR groups kept as rows. The same revival
 *  applySavedSegment performs. */
function seedGroups(segment: Segment | undefined): FilterCondition[][] {
  if (!segment) return [[]];
  const revive = (cs?: SegmentCondition[]): FilterCondition[] =>
    (cs ?? []).map((c) => ({
      id: crypto.randomUUID(),
      field: c.field,
      op: c.op as FilterOp,
      ...(c.value !== undefined ? { value: c.value } : {}),
    }));
  const flat = revive(segment.conditions);
  if (segment.company?.trim()) {
    flat.push({ id: crypto.randomUUID(), field: "company", op: "is", value: segment.company.trim() });
  }
  if (segment.attrKey?.trim()) {
    const val = segment.attrValue?.trim() ?? "";
    flat.push(
      val
        ? { id: crypto.randomUUID(), field: `attr:${segment.attrKey.trim()}`, op: "is", value: val }
        : { id: crypto.randomUUID(), field: `attr:${segment.attrKey.trim()}`, op: "exists" },
    );
  }
  return joinFilterGroups(flat, segment.conditionGroups?.map((g) => revive(g)));
}

function ComposeBroadcast({
  draft,
  onCancel,
  onSaved,
  onError,
}: {
  /** The draft being re-edited; null composes a NEW broadcast. */
  draft: Broadcast | null;
  onCancel: () => void;
  /** Fires after create (updated=false) or a successful PATCH (updated=true). */
  onSaved: (b: Broadcast, updated: boolean) => void;
  onError: (msg: string) => void;
}) {
  const [subject, setSubject] = useState(draft?.subject ?? "");
  const [body, setBody] = useState(draft && draft.channel !== "email" ? draft.body : "");
  const [channel, setChannel] = useState<BroadcastChannel>(draft?.channel ?? "email");
  const isEmail = channel === "email";
  // Discord is a channel-post, not a per-recipient send (0078): the audience is ONE channel, not a
  // contact segment. These carry the post's target + options instead of the segment builder.
  const isDiscord = channel === "discord";
  const [targetRef, setTargetRef] = useState(draft?.target_ref ?? "");
  const [mentionRoleId, setMentionRoleId] = useState(draft?.mention_role_id ?? "");
  const [asEmbed, setAsEmbed] = useState(draft?.as_embed ?? false);

  // Email content is composed as ordered BLOCKS; chat channels keep the plain
  // textarea. Both states live side by side so switching channels never loses
  // work — see pickChannel below.
  const [blocks, setBlocks] = useState<EditorBlock[]>(() => seedBlocks(draft));
  // Once the operator types in the chat textarea it's theirs — the text-block
  // seeding on a channel switch stops overwriting it. A chat draft's stored
  // body counts as "theirs" from the start.
  const [bodyTouched, setBodyTouched] = useState(!!draft && draft.channel !== "email");
  const [showPreview, setShowPreview] = useState(true);

  function pickChannel(id: BroadcastChannel) {
    // Switching to a chat channel seeds the plain textarea from the text blocks
    // (joined by blank lines) until the operator has typed there themselves.
    if (id !== "email" && !bodyTouched) setBody(textFromBlocks(blocks));
    setChannel(id);
    setError(null);
  }
  // Email stationery — applies to the email channel only; "branded" is the
  // server default so the picker starts there.
  const [templateId, setTemplateId] = useState(draft?.template_id ?? "branded");
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  useEffect(() => {
    fetchEmailTemplates().then(setTemplates).catch(() => setTemplates([]));
  }, []);
  const [q, setQ] = useState(draft?.segment?.q ?? "");
  // Audience filters as OR groups: rows OR together, conditions within a row AND
  // together. One (possibly empty) group = the classic flat filter.
  const [groups, setGroups] = useState<FilterCondition[][]>(() => seedGroups(draft?.segment));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Conversion goal (email only) — a contact_events name plus a window in days.
  // Sent only when the event name is non-empty; days clamp to the server's 1–90.
  const [goalEvent, setGoalEvent] = useState(draft?.goal_event ?? "");
  const [goalDays, setGoalDays] = useState(String(draft?.goal_days ?? 7));
  const clampGoalDays = (v: string): number => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(90, Math.max(1, n)) : 7;
  };

  // Delivery timing — "now" ships as the server-default oneshot, "schedule"
  // stores a send_at, "continuous" flips the mode. The pickers hold local
  // datetime-local strings; conversion to ISO happens only at submit.
  const [timing, setTiming] = useState<"now" | "schedule" | "continuous">(
    draft?.mode === "continuous" ? "continuous" : draft?.send_at ? "schedule" : "now",
  );
  const [sendAtLocal, setSendAtLocal] = useState(draft?.send_at ? isoToLocalInput(draft.send_at) : "");
  const [stopAtLocal, setStopAtLocal] = useState(draft?.stop_at ? isoToLocalInput(draft.stop_at) : "");

  // Send window — an optional disclosure inside Delivery. Scheduler-driven
  // sends (a scheduled fire, continuous ticks) only run inside it; "Send now"
  // bypasses. Off = the fields don't ship at all (a re-edited draft clears its
  // stored window instead). Time bounds always ship as a pair; the offset
  // defaults to the operator's own zone (the SLA business-hours idiom).
  const hasStoredWindow = !!(draft?.window_days?.length || draft?.window_start_min != null);
  const [windowOn, setWindowOn] = useState(hasStoredWindow);
  const [windowDays, setWindowDays] = useState<number[]>(
    draft?.window_days?.length ? [...draft.window_days].sort((a, b) => a - b) : hasStoredWindow ? [1, 2, 3, 4, 5, 6, 7] : [1, 2, 3, 4, 5],
  );
  const [winStartMin, setWinStartMin] = useState(draft?.window_start_min ?? 540);
  const [winEndMin, setWinEndMin] = useState(draft?.window_end_min ?? 1020);
  const [windowTz, setWindowTz] = useState(
    draft?.window_tz_offset_min ?? -new Date().getTimezoneOffset(),
  );
  function toggleWindowDay(n: number) {
    setWindowDays((ds) => (ds.includes(n) ? ds.filter((d) => d !== n) : [...ds, n].sort((a, b) => a - b)));
    setError(null);
  }
  // The quiet confirmation line under each picker — the chosen time in words,
  // only once the value parses.
  const wordsFromLocal = (v: string): string | null => {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : sendTimeWords(d.toISOString());
  };

  // Attribute keys the builder can target, harvested from one contacts page (the
  // directory's approach, minus its accumulation — one page is plenty for compose).
  // Best-effort: an empty/failed fetch just means no attr:<key> fields on offer.
  const [attrKeys, setAttrKeys] = useState<string[]>([]);
  useEffect(() => {
    fetchContacts({ limit: 50 })
      .then((r) => {
        const keys = new Set<string>();
        for (const c of r.contacts) for (const k of Object.keys(c.attributes ?? {})) keys.add(k);
        setAttrKeys([...keys].sort());
      })
      .catch(() => {});
  }, []);

  // The same field catalog the contacts directory filters on (contacts-list.tsx),
  // so a segment composed here matches what Customers would show.
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
      // The event prompt — picking it asks for a contact_events name and filters
      // on event:<name> (did it / never did it / when). There's no distinct-names
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

  // Channel catalog (GET /channels) — gates the picker: a channel without its
  // server-side credentials can't carry a broadcast, so its option disables.
  const [channelStatuses, setChannelStatuses] = useState<ChannelStatus[] | null>(null);
  useEffect(() => {
    fetchChannels().then(setChannelStatuses).catch(() => setChannelStatuses(null));
  }, []);
  // Unknown catalog (still loading / endpoint failed) leaves options enabled —
  // the server enforces; we only gate when we positively know creds are missing.
  const isCredentialed = (id: BroadcastChannel) =>
    channelStatuses?.find((c) => c.id === id)?.credentialed ?? true;

  // Saved segments (segments.ts) — pick one to prefill the audience filters. Manual edits after a
  // pick clear the link so the broadcast isn't mislabeled as "the saved segment".
  const [savedSegments, setSavedSegments] = useState<SavedSegment[]>([]);
  const [segmentId, setSegmentId] = useState<string | null>(null);
  useEffect(() => { fetchSegments("contacts").then(setSavedSegments).catch(() => setSavedSegments([])); }, []);

  function applySavedSegment(id: string) {
    const seg = savedSegments.find((s) => s.id === id);
    if (!seg) { setSegmentId(null); return; }
    const d = (seg.definition ?? {}) as Record<string, unknown>;
    setQ(typeof d.q === "string" ? d.q : "");
    // Saved views persist the builder grammar as `filters` (segments.ts) — OR-grouped
    // views as `filterGroups`; tolerate `conditions` too. Each condition gets a fresh
    // client id — ids never round-trip.
    const revive = (raw: unknown): FilterCondition[] => {
      const out: FilterCondition[] = [];
      if (!Array.isArray(raw)) return out;
      for (const f of raw as Array<Record<string, unknown>>) {
        if (f && typeof f.field === "string" && typeof f.op === "string") {
          out.push({
            id: crypto.randomUUID(),
            field: f.field,
            op: f.op as FilterOp,
            value: typeof f.value === "string" ? f.value : undefined,
          });
        }
      }
      return out;
    };
    const next = revive(Array.isArray(d.filters) ? d.filters : d.conditions);
    // Legacy flat fields (pre-builder saved segments) fold into equivalent conditions.
    if (typeof d.company === "string" && d.company.trim()) {
      next.push({ id: crypto.randomUUID(), field: "company", op: "is", value: d.company.trim() });
    }
    if (typeof d.attrKey === "string" && d.attrKey.trim()) {
      const val = typeof d.attrValue === "string" ? d.attrValue.trim() : "";
      next.push(
        val
          ? { id: crypto.randomUUID(), field: `attr:${d.attrKey.trim()}`, op: "is", value: val }
          : { id: crypto.randomUUID(), field: `attr:${d.attrKey.trim()}`, op: "exists" },
      );
    }
    const savedGroups = Array.isArray(d.filterGroups) ? (d.filterGroups as unknown[]).map(revive) : undefined;
    setGroups(joinFilterGroups(next, savedGroups));
    setSegmentId(id);
  }
  // Any manual filter edit detaches from the saved segment.
  const editQ = (v: string) => { setQ(v); setSegmentId(null); };
  const editGroups = (next: FilterCondition[][]) => { setGroups(next); setSegmentId(null); };

  const [preview, setPreview] = useState<SegmentPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);

  // A chip whose op needs a value but has none yet is still being built — it neither
  // filters the preview nor ships with the draft (same rule as the contacts directory).
  // The client-only `id` is stripped here; the API's grammar is {field, op, value?}.
  // One group ships as the flat `conditions`; two or more as `conditionGroups` (OR-ed).
  const segment = useMemo<Segment>(() => {
    const complete = (c: FilterCondition) =>
      c.op === "exists" || c.op === "not_exists" || (c.value ?? "").trim() !== "";
    const strip = (c: FilterCondition): SegmentCondition => ({
      field: c.field,
      op: c.op,
      ...(c.value !== undefined ? { value: c.value } : {}),
    });
    const { flat, groups: orGroups } = splitFilterGroups(
      groups.map((g) => g.filter(complete).map(strip)),
    );
    return { q, conditions: flat, ...(orGroups ? { conditionGroups: orGroups } : {}) };
  }, [q, groups]);

  // Debounced live reach preview — recomputes whenever the segment changes. Skipped for a
  // channel-post (Discord): its audience is one channel, not a contact segment, so there's no reach.
  useEffect(() => {
    if (isDiscord) return;
    let live = true;
    setPreviewing(true);
    setPreviewFailed(false);
    const t = setTimeout(async () => {
      try {
        const p = await previewSegment(segment);
        if (live) setPreview(p);
      } catch {
        if (live) {
          setPreview(null);
          setPreviewFailed(true);
        }
      } finally {
        if (live) setPreviewing(false);
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [segment, isDiscord]);

  // What ships for the email channel (ids stripped, empty text blocks dropped)
  // and the one reason it can't yet — mirrors the server's schema so Create
  // disables instead of round-tripping a 400.
  const emailBlocks = useMemo(() => cleanBlocks(blocks), [blocks]);
  const emailBlockProblem = useMemo(() => {
    for (const b of emailBlocks) {
      const why = blockIssue(b);
      if (why) return why;
    }
    return emailBlocks.length === 0 ? "Add at least one block with content." : null;
  }, [emailBlocks]);

  // Live rendered-email preview — the server's send-path renderer with sample
  // merge data, debounced. Only valid blocks go up mid-edit (a half-typed image
  // URL would 400 and blank the frame while the operator is still typing).
  const renderBlocks = useMemo(() => previewableBlocks(blocks), [blocks]);
  const [renderHtml, setRenderHtml] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [renderFailed, setRenderFailed] = useState(false);
  useEffect(() => {
    if (!isEmail || !showPreview) return; // hidden or chat: no renders in flight
    let live = true;
    setRendering(true);
    const t = setTimeout(async () => {
      try {
        const p = await previewBroadcastRender({
          subject: subject.trim() || undefined,
          // No valid blocks yet renders the empty stationery — the frame never blanks.
          ...(renderBlocks.length > 0 ? { blocks: renderBlocks } : { body: "" }),
          templateId,
        });
        if (live) {
          setRenderHtml(p.html);
          setRenderFailed(false);
        }
      } catch {
        if (live) setRenderFailed(true);
      } finally {
        if (live) setRendering(false);
      }
    }, RENDER_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [isEmail, showPreview, subject, renderBlocks, templateId]);

  // Chat-channel twin of the email render — same endpoint, same debounce; the
  // response's `chat` block carries every channel's form at once, so switching
  // between chat channels re-reads it without another round-trip.
  const [chatPreview, setChatPreview] = useState<BroadcastChatPreview | null>(null);
  const [chatRendering, setChatRendering] = useState(false);
  const [chatFailed, setChatFailed] = useState(false);
  useEffect(() => {
    if (isEmail || !showPreview) return; // email or hidden: no chat renders in flight
    let live = true;
    setChatRendering(true);
    const t = setTimeout(async () => {
      try {
        const p = await previewBroadcastRender({
          subject: subject.trim() || undefined,
          body,
        });
        if (live) {
          // An older server without `chat` reads as a render failure — the
          // pane says so instead of holding an empty bubble forever.
          setChatPreview(p.chat ?? null);
          setChatFailed(!p.chat);
        }
      } catch {
        if (live) setChatFailed(true);
      } finally {
        if (live) setChatRendering(false);
      }
    }, RENDER_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [isEmail, showPreview, subject, body]);

  // "Send test to me" — one rendered email to the signed-in agent's own address.
  const [testBusy, setTestBusy] = useState(false);
  const canTest = subject.trim() !== "" && renderBlocks.length > 0;
  async function sendTest() {
    if (!canTest || testBusy) return;
    setTestBusy(true);
    try {
      const res = await sendBroadcastTest({
        subject: subject.trim(),
        blocks: renderBlocks,
        templateId,
      });
      toast.success(`Test sent to ${res.to}.`);
    } catch (err) {
      // The server's reason (400 subject / 502 mailer) beats a generic apology.
      toast.error((err as ApiError).detail ?? "Couldn't send the test email.");
    } finally {
      setTestBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const s = subject.trim();
    const b = body.trim();
    if (!s) {
      setError("Give your broadcast a subject.");
      return;
    }
    if (isEmail) {
      if (emailBlockProblem) {
        setError(emailBlockProblem);
        return;
      }
    } else if (!b) {
      setError("Write a message body.");
      return;
    }
    if (isDiscord && !targetRef.trim()) {
      setError("Paste the id of the Discord channel to post to.");
      return;
    }
    // Delivery times validate before the round-trip — an invalid or past
    // datetime would only come back as a 400.
    let sendAt: string | undefined;
    let stopAt: string | undefined;
    if (timing === "schedule") {
      const t = new Date(sendAtLocal);
      if (!sendAtLocal || Number.isNaN(t.getTime())) {
        setError("Pick a date and time to schedule.");
        return;
      }
      if (t.getTime() <= Date.now()) {
        setError("The scheduled time has to be in the future.");
        return;
      }
      sendAt = t.toISOString();
    }
    if (timing === "continuous" && stopAtLocal) {
      const t = new Date(stopAtLocal);
      if (Number.isNaN(t.getTime())) {
        setError("The stop date isn't a valid date.");
        return;
      }
      if (t.getTime() <= Date.now()) {
        setError("The stop date has to be in the future.");
        return;
      }
      stopAt = t.toISOString();
    }
    // The send window validates client-side too — the server would 400 an
    // empty day set (it reads as "no window") or inverted bounds.
    if (windowOn) {
      if (windowDays.length === 0) {
        setError("Pick at least one day for the send window.");
        return;
      }
      if (winStartMin >= winEndMin) {
        setError("The send window has to end after it starts.");
        return;
      }
    }
    setBusy(true);
    try {
      if (draft) {
        // Re-editing: PATCH the full form state back. Undefined keeps a stored
        // value, so anything the form can EMPTY ships an explicit clear ("" for
        // the ISO fields and the goal, null for the window).
        const saved = await updateBroadcast(draft.id, {
          subject: s,
          body: isEmail ? textFromBlocks(blocks) : b,
          // A chat draft that still carries blocks (composed as email first)
          // must replace them — the server derives `body` from stored blocks
          // otherwise, ignoring the textarea edit. One text block of the chat
          // body keeps the derivation honest and survives a later email switch.
          ...(isEmail
            ? { blocks: emailBlocks, templateId }
            : draft.blocks?.length
              ? { blocks: [{ type: "text" as const, md: b }] }
              : {}),
          channel,
          // Discord is a channel-post (0078): the target channel + options replace the segment.
          ...(isDiscord
            ? { audienceKind: "discord_channel" as const, targetRef: targetRef.trim(), mentionRoleId: mentionRoleId.trim() || null, asEmbed }
            : {}),
          segment,
          ...(segmentId ? { segmentId } : {}),
          mode: timing === "continuous" ? "continuous" : "oneshot",
          sendAt: sendAt ?? "",
          stopAt: stopAt ?? "",
          goalEvent: isEmail ? goalEvent.trim() : "",
          ...(isEmail && goalEvent.trim() ? { goalDays: clampGoalDays(goalDays) } : {}),
          windowDays: windowOn ? windowDays : null,
          windowStartMin: windowOn ? winStartMin : null,
          windowEndMin: windowOn ? winEndMin : null,
          windowTzOffsetMin: windowOn ? windowTz : null,
        });
        onSaved(saved, true);
        return;
      }
      const created = await createBroadcast({
        subject: s,
        // With blocks the server derives the plaintext form itself and ignores
        // `body`; the joined text blocks ride along only to satisfy the field.
        body: isEmail ? textFromBlocks(blocks) : b,
        ...(isEmail ? { blocks: emailBlocks } : {}),
        channel,
        // Template is an email concept — other channels render plain.
        ...(isEmail ? { templateId } : {}),
        // Discord is a channel-post (0078): the target channel + options replace the segment.
        ...(isDiscord
          ? { audienceKind: "discord_channel" as const, targetRef: targetRef.trim(), mentionRoleId: mentionRoleId.trim() || null, asEmbed }
          : {}),
        segment,
        segmentId,
        // Timing rides on the draft; arming happens later, from Send.
        ...(timing === "continuous" ? { mode: "continuous" as const } : {}),
        ...(sendAt ? { sendAt } : {}),
        ...(stopAt ? { stopAt } : {}),
        // Goal is an email concept (opens/clicks/conversions ride the email
        // tracking); it ships only when an event name was given.
        ...(isEmail && goalEvent.trim()
          ? { goalEvent: goalEvent.trim(), goalDays: clampGoalDays(goalDays) }
          : {}),
        // The send window ships only while the disclosure is on.
        ...(windowOn
          ? {
              windowDays,
              windowStartMin: winStartMin,
              windowEndMin: winEndMin,
              windowTzOffsetMin: windowTz,
            }
          : {}),
      });
      onSaved(created, false);
    } catch (err) {
      const e = err as ApiError;
      if (draft && e.status === 409) {
        // The draft got armed/sent under us — surface the server's reason.
        const msg = e.detail ?? "Only drafts can be edited.";
        onError(msg);
        setError(msg);
      } else {
        onError(
          isBroadcastsUnavailable(err)
            ? "Broadcasts aren't available on this server yet."
            : draft
              ? "Couldn't save the draft. Please try again."
              : "Couldn't create the draft. Please try again.",
        );
        setError("Save failed — please try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  const hasFilters = !!q.trim() || groups.some((g) => g.length > 0);

  return (
    <form
      onSubmit={(e) => void submit(e)}
      // One column normally; at xl the live email preview docks to the right of
      // the form instead of stacking below it.
      className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6 xl:max-w-[1360px] xl:flex-row xl:items-start xl:justify-center"
    >
      <div className="w-full min-w-0 xl:max-w-2xl">
      <div className="mb-5 flex items-center gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground md:hidden"
        >
          <ChevronLeft className="size-4" />
        </button>
        <h1 className="text-xl font-semibold tracking-tight">
          {draft ? "Edit broadcast" : "New broadcast"}
        </h1>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-8 gap-1.5 text-xs text-muted-foreground"
          onClick={() => setShowPreview((v) => !v)}
        >
          {showPreview ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          {showPreview ? "Hide preview" : "Show preview"}
        </Button>
      </div>

      <div className="space-y-4 rounded-xl border bg-card p-6 shadow-sm">
        <div className="space-y-1.5">
          <Label htmlFor="b-subject">Subject</Label>
          <Input
            id="b-subject"
            value={subject}
            onChange={(e) => {
              setSubject(e.target.value);
              setError(null);
            }}
            placeholder="What's new this month"
            autoComplete="off"
          />
          {isEmail && (
            <p className="text-xs text-muted-foreground">
              Variables like <code className="font-mono">{"{{firstName|there}}"}</code> are filled
              in per recipient.
            </p>
          )}
        </div>
        {isEmail ? (
          <div className="space-y-1.5">
            <Label>Message</Label>
            <BlockComposer
              blocks={blocks}
              onChange={(next) => {
                setBlocks(next);
                setError(null);
              }}
            />
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="b-body">Message</Label>
            <Textarea
              id="b-body"
              value={body}
              onChange={(e) => {
                setBody(e.target.value);
                setBodyTouched(true);
                setError(null);
              }}
              placeholder="Write the message your contacts will receive…"
              className="min-h-40"
            />
            <p className="text-xs text-muted-foreground">
              Chat channels receive plain text with simple formatting.
            </p>
          </div>
        )}

        {/* email template — the stationery the message renders in. Email-only;
            other channels deliver plain text, so the picker hides with them. */}
        {channel === "email" && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="mb-0">Template</Label>
              <Link
                to="/settings/email-templates"
                className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Manage templates
              </Link>
            </div>
            {templates.length > 0 ? (
              <div>
                <PopoverSelect
                  value={templateId}
                  options={templates.map((t) => ({
                    value: t.id,
                    label: t.builtin ? `${t.name} · Built-in` : t.name,
                  }))}
                  onChange={(v) => setTemplateId(v ?? "branded")}
                  align="start"
                />
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                The built-in Branded template will be used.
              </p>
            )}
          </div>
        )}

        {/* channel picker — segmented, each option carries its reachable count from
            the live preview; uncredentialed channels disable (server-gated too) */}
        <div className="space-y-1.5">
          <Label>Channel</Label>
          <div
            role="radiogroup"
            aria-label="Delivery channel"
            // w-fit flex (not inline-flex) — the inline Label above would otherwise
            // share its line and jam against the control.
            className="flex w-fit flex-wrap items-center gap-0.5 rounded-lg border bg-muted/60 p-0.5"
          >
            {BROADCAST_CHANNELS.map((id) => {
              const enabled = isCredentialed(id);
              const reach = preview?.reachable[id];
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={channel === id}
                  disabled={!enabled}
                  title={enabled ? undefined : CHANNEL_CRED_HINT[id]}
                  onClick={() => pickChannel(id)}
                  className={cn(
                    TAB_BASE,
                    channel === id ? TAB_ON : TAB_OFF,
                    !enabled && "cursor-not-allowed opacity-45 hover:text-muted-foreground",
                  )}
                >
                  {CHANNEL_LABEL[id]}
                  {reach != null && (
                    <span
                      className={cn(
                        "tabular-nums",
                        channel === id ? "text-muted-foreground" : "text-muted-foreground/70",
                      )}
                    >
                      · {reach.toLocaleString()}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Discord channel-post (0078): no contact segment — ONE post to a channel. */}
        {isDiscord && (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <SlidersHorizontal className="size-3.5 text-muted-foreground" />
              <Label className="mb-0">Where to post</Label>
            </div>
            <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
              <p className="text-xs text-muted-foreground">
                A Discord broadcast posts <span className="font-medium text-foreground">one message</span> to a
                channel — it never DMs your members. Paste the target channel’s id (Discord → right-click the
                channel → Copy Channel ID, with Developer Mode on).
              </p>
              <div className="space-y-1">
                <Label htmlFor="b-target" className="text-xs">
                  Channel id
                </Label>
                <Input
                  id="b-target"
                  value={targetRef}
                  onChange={(e) => {
                    setTargetRef(e.target.value);
                    setError(null);
                  }}
                  placeholder="e.g. 1180000000000000000"
                  className="h-8 font-mono text-xs"
                  autoComplete="off"
                  inputMode="numeric"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="b-role" className="text-xs">
                  Ping a role <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="b-role"
                  value={mentionRoleId}
                  onChange={(e) => setMentionRoleId(e.target.value)}
                  placeholder="Role id — only this role is pinged, never @everyone"
                  className="h-8 font-mono text-xs"
                  autoComplete="off"
                  inputMode="numeric"
                />
              </div>
              <label className="flex items-center justify-between gap-3 pt-0.5">
                <span className="space-y-0.5">
                  <span className="block text-xs font-medium">Post as an embed</span>
                  <span className="block text-xs text-muted-foreground">
                    Renders in a bordered card with the subject as its title.
                  </span>
                </span>
                <Switch checked={asEmbed} onCheckedChange={setAsEmbed} />
              </label>
            </div>
          </div>
        )}

        {/* segment builder — the same filters as the contacts directory */}
        {!isDiscord && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <SlidersHorizontal className="size-3.5 text-muted-foreground" />
            <Label className="mb-0">Audience</Label>
          </div>
          <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
            {savedSegments.length > 0 && (
              <div className="space-y-1">
                <Label className="text-xs">Saved segment</Label>
                <div>
                  <PopoverSelect
                    value={segmentId}
                    options={[
                      { value: null, label: "Custom filter…" },
                      ...savedSegments.map((s) => ({ value: s.id, label: s.name })),
                    ]}
                    onChange={(v) => (v ? applySavedSegment(v) : setSegmentId(null))}
                    align="start"
                  />
                </div>
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="b-q" className="text-xs">
                Keyword search
              </Label>
              <Input
                id="b-q"
                value={q}
                onChange={(e) => editQ(e.target.value)}
                placeholder="Matches name, email, or company…"
                className="h-8 text-xs"
                autoComplete="off"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Filters</Label>
              {/* the contacts directory's condition builder, verbatim — a segment
                  composed here is the same grammar a saved Customers view stores.
                  "+ Or" adds an OR-ed row (each row's conditions AND together). */}
              <FilterBuilder fields={filterFields} groups={groups} onChange={editGroups} />
            </div>
            {hasFilters && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={() => {
                  setQ("");
                  setGroups([[]]);
                  setSegmentId(null);
                }}
              >
                <X className="size-3.5" /> Clear audience
              </Button>
            )}
          </div>

          {/* live reach preview */}
          <div className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm">
            <Users className="size-4 shrink-0 text-muted-foreground" />
            {previewing ? (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> Counting the
                audience…
              </span>
            ) : previewFailed ? (
              <span className="text-muted-foreground">
                Couldn't preview the audience — you can still create the draft.
              </span>
            ) : preview ? (
              (() => {
                // Reach is per channel — the line always speaks for the CHOSEN one.
                const reach = preview.reachable[channel] ?? 0;
                const unreachable = Math.max(0, preview.total - reach);
                return (
                  <span>
                    Will send to <span className="font-semibold tabular-nums">{reach.toLocaleString()}</span>{" "}
                    {reach === 1 ? "contact" : "contacts"} via {CHANNEL_LABEL[channel]}
                    <span className="text-muted-foreground">
                      {" "}
                      ({preview.total.toLocaleString()} match
                      {unreachable > 0
                        ? `, ${unreachable.toLocaleString()} not reachable on ${CHANNEL_LABEL[channel]}`
                        : ""}
                      )
                    </span>
                  </span>
                );
              })()
            ) : (
              <span className="text-muted-foreground">Refine the audience to preview reach.</span>
            )}
          </div>
        </div>
        )}

        {/* delivery timing — WHEN the broadcast goes out once its draft is
            sent. Radio cards: the header row is the radio; a card's extra
            controls render inside it only while selected. A channel-post posts
            immediately on send (no schedule/continuous/window), so it's hidden. */}
        {!isDiscord && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <Clock className="size-3.5 text-muted-foreground" />
            <Label className="mb-0">Delivery</Label>
          </div>
          <div role="radiogroup" aria-label="Delivery timing" className="space-y-1.5">
            <TimingOption
              checked={timing === "now"}
              onSelect={() => {
                setTiming("now");
                setError(null);
              }}
              title="Send immediately"
              description="Delivery starts as soon as you send the draft."
            />
            <TimingOption
              checked={timing === "schedule"}
              onSelect={() => {
                setTiming("schedule");
                setError(null);
              }}
              title="Schedule for later"
              description="Sending the draft arms it; delivery starts by itself at the time you pick."
            >
              <Input
                type="datetime-local"
                value={sendAtLocal}
                min={localMinuteNow()}
                onChange={(e) => {
                  setSendAtLocal(e.target.value);
                  setError(null);
                }}
                className="h-8 w-fit text-xs"
                aria-label="Scheduled send time"
              />
              {wordsFromLocal(sendAtLocal) && (
                <p className="text-xs text-muted-foreground">Sends {wordsFromLocal(sendAtLocal)}.</p>
              )}
            </TimingOption>
            <TimingOption
              checked={timing === "continuous"}
              onSelect={() => {
                setTiming("continuous");
                setError(null);
              }}
              title="Send continuously"
              description="Sends once to each person the first time they match the audience. People already in the audience receive it on the first pass."
            >
              <div className="space-y-1">
                <Label htmlFor="b-stop" className="text-xs">
                  Stop date (optional)
                </Label>
                <Input
                  id="b-stop"
                  type="datetime-local"
                  value={stopAtLocal}
                  min={localMinuteNow()}
                  onChange={(e) => {
                    setStopAtLocal(e.target.value);
                    setError(null);
                  }}
                  className="h-8 w-fit text-xs"
                />
              </div>
              {wordsFromLocal(stopAtLocal) && (
                <p className="text-xs text-muted-foreground">Stops {wordsFromLocal(stopAtLocal)}.</p>
              )}
            </TimingOption>
          </div>

          {/* send window — an optional disclosure: scheduler-driven deliveries
              (a scheduled fire, continuous matching) only run inside it. The
              fields ship only while it's on. */}
          <div className="rounded-lg border border-input">
            <label className="flex w-full cursor-pointer items-start justify-between gap-3 p-3">
              <span className="min-w-0">
                <span className="block text-sm font-medium">Send window</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Scheduled and continuous deliveries only go out on these days and hours.
                  "Send immediately" ignores the window.
                </span>
              </span>
              <Switch
                checked={windowOn}
                onCheckedChange={(v) => {
                  setWindowOn(v);
                  setError(null);
                }}
              />
            </label>
            {windowOn && (
              <div className="space-y-3 border-t border-border/60 p-3">
                <div>
                  <Label className="mb-1.5 block text-xs">Days</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {ISO_WEEKDAYS.map((label, i) => {
                      const n = i + 1; // ISO: Mon=1…Sun=7
                      const on = windowDays.includes(n);
                      return (
                        <button
                          key={n}
                          type="button"
                          aria-pressed={on}
                          onClick={() => toggleWindowDay(n)}
                          className={cn(
                            "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                            on
                              ? "border-primary bg-primary/10 text-primary"
                              : "border-border text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="b-win-from" className="text-xs">
                      From
                    </Label>
                    <Input
                      id="b-win-from"
                      type="time"
                      value={minToTime(winStartMin)}
                      onChange={(e) => {
                        setWinStartMin(timeToMin(e.target.value));
                        setError(null);
                      }}
                      className="h-8 w-fit text-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="b-win-to" className="text-xs">
                      Until
                    </Label>
                    <Input
                      id="b-win-to"
                      type="time"
                      value={minToTime(winEndMin)}
                      onChange={(e) => {
                        setWinEndMin(timeToMin(e.target.value));
                        setError(null);
                      }}
                      className="h-8 w-fit text-xs"
                    />
                  </div>
                  {/* the SLA business-hours offset idiom — hours, fixed (no DST) */}
                  <div className="space-y-1">
                    <Label htmlFor="b-win-tz" className="text-xs">
                      UTC offset (hours)
                    </Label>
                    <Input
                      id="b-win-tz"
                      type="number"
                      min={-14}
                      max={14}
                      step="any"
                      value={windowTz / 60}
                      onChange={(e) =>
                        setWindowTz(
                          Math.min(840, Math.max(-840, Math.round((Number(e.target.value) || 0) * 60))),
                        )
                      }
                      className="h-8 w-20 text-xs tabular-nums"
                    />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Fixed weekly schedule (no daylight-saving shifts), in the wall clock set by the
                  UTC offset — currently {tzOffsetWords(windowTz)}.
                </p>
              </div>
            )}
          </div>
        </div>
        )}

        {/* conversion goal (email only) — which contact event counts as success,
            and how long after delivery it still counts. Optional; the draft
            ships without one when the event name stays empty. */}
        {isEmail && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Target className="size-3.5 text-muted-foreground" />
              <Label htmlFor="b-goal" className="mb-0">
                Goal
              </Label>
              <span className="text-xs text-muted-foreground">optional</span>
            </div>
            <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id="b-goal"
                  value={goalEvent}
                  onChange={(e) => setGoalEvent(e.target.value)}
                  placeholder="signed_up"
                  className="h-8 w-44 font-mono text-xs"
                  autoComplete="off"
                  aria-label="Goal event name"
                />
                <span className="text-xs text-muted-foreground">within</span>
                <Input
                  type="number"
                  min={1}
                  max={90}
                  step={1}
                  value={goalDays}
                  onChange={(e) => setGoalDays(e.target.value)}
                  onBlur={() => setGoalDays(String(clampGoalDays(goalDays)))}
                  className="h-8 w-16 text-xs tabular-nums"
                  aria-label="Goal window in days"
                />
                <span className="text-xs text-muted-foreground">days</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Counts recipients who do this event within the window after delivery. Links are
                tracked automatically and tagged with UTM parameters.
              </p>
            </div>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy || (isEmail && !!emailBlockProblem)}>
          {busy ? (
            <>
              <Loader2 className="animate-spin motion-reduce:animate-none" />{" "}
              {draft ? "Saving…" : "Creating…"}
            </>
          ) : draft ? (
            "Save changes"
          ) : (
            "Create draft"
          )}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        {/* the quiet WHY next to a disabled Create — never a mystery button */}
        {isEmail && emailBlockProblem && (
          <span className="text-xs text-muted-foreground">{emailBlockProblem}</span>
        )}
      </div>
      </div>

      {/* ── live rendered preview — the send-path renderer with sample merge
          data (Ada Lovelace). Docks right at xl, stacks below otherwise. Email
          gets the framed document; chat channels get the bubble mock. ──── */}
      {!isEmail && showPreview && (
        <aside className="w-full min-w-0 xl:sticky xl:top-6 xl:w-[400px] xl:shrink-0">
          <ChatPreview
            chat={chatPreview}
            channel={channel}
            channelLabel={CHANNEL_LABEL[channel]}
            refreshing={chatRendering}
            failed={chatFailed}
            className="max-h-[calc(100vh-7rem)] overflow-hidden rounded-xl border bg-muted/30 shadow-sm"
          />
        </aside>
      )}
      {isEmail && showPreview && (
        <aside className="w-full min-w-0 xl:sticky xl:top-6 xl:w-[560px] xl:shrink-0">
          <EmailPreview
            html={renderHtml}
            refreshing={rendering}
            failed={renderFailed}
            frameHeight={560}
            className="max-h-[calc(100vh-7rem)] overflow-hidden rounded-xl border bg-muted/30 shadow-sm"
            actions={
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 gap-1 px-2 text-xs"
                disabled={!canTest || testBusy}
                onClick={() => void sendTest()}
                title={
                  canTest
                    ? "Sends the current draft to your own address"
                    : "Add a subject and some content first"
                }
              >
                {testBusy ? (
                  <Loader2 className="size-3 animate-spin motion-reduce:animate-none" />
                ) : (
                  <Send className="size-3" />
                )}
                Send test to me
              </Button>
            }
          />
        </aside>
      )}
    </form>
  );
}

// The current minute as a datetime-local value — the floor for both delivery
// pickers (datetime-local is timezone-naive, so this must be LOCAL time, not
// an ISO slice).
function localMinuteNow(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** One delivery-timing choice — a full-width radio card (the checkbox/filter
 *  selected idiom: border-primary + a quiet tint). The header row is the
 *  radio button; `children` (the pickers) render inside the card only while
 *  it's selected, so no input ever nests inside the button. */
function TimingOption({
  checked,
  onSelect,
  title,
  description,
  children,
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border transition-colors",
        checked ? "border-primary bg-primary/5" : "border-input",
      )}
    >
      <button
        type="button"
        role="radio"
        aria-checked={checked}
        onClick={onSelect}
        className="flex w-full items-start gap-2.5 p-3 text-left"
      >
        <span
          aria-hidden
          className={cn(
            "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border",
            checked ? "border-primary" : "border-input",
          )}
        >
          {checked && <span className="size-2 rounded-full bg-primary" />}
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-medium">{title}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
        </span>
      </button>
      {/* indented to the title's left edge: p-3 (12px) + disc (16px) + gap (10px) */}
      {checked && children != null && <div className="space-y-1.5 pb-3 pl-[38px] pr-3">{children}</div>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Detail — content preview, the segment used, counts, and recipient delivery.
// Self-fetching + live: fetches fresh by id (deep-link safe), subscribes to
// realtime, and polls while mid-send so the sent/failed tallies climb without a
// manual refresh. Reused by the routed /broadcasts/$broadcastId page.
// ─────────────────────────────────────────────────────────────────────────────
type DetailState = "loading" | "ok" | "notfound" | "error";

export function BroadcastDetail({
  broadcastId,
  onBack,
  onSend,
  onCancel,
  onEdit,
}: {
  broadcastId: string;
  onBack: () => void;
  onSend: (b: Broadcast) => void;
  /** POST /cancel — disarms a "scheduled" broadcast back to draft, or stops an
   *  "active" one for good. The routed page decides how much to confirm. */
  onCancel: (b: Broadcast) => void;
  /** Drafts only: reopen this draft in the composer (the routed page navigates
   *  to the list with ?edit=<id>). */
  onEdit?: (b: Broadcast) => void;
}) {
  const { subscribe } = useRealtime();
  const [broadcast, setBroadcast] = useState<Broadcast | null>(null);
  const [recipients, setRecipients] = useState<Recipient[] | null>(null);
  const [stats, setStats] = useState<BroadcastStats | null>(null);
  const [state, setState] = useState<DetailState>("loading");
  const [recipFilter, setRecipFilter] = useState<"all" | "failed" | "sent">("all");

  // Templates resolve the email template id into its name (best-effort — the
  // built-in map covers "branded"/"personal" if the fetch fails).
  const [templates, setTemplates] = useState<EmailTemplate[] | null>(null);
  useEffect(() => {
    fetchEmailTemplates().then(setTemplates).catch(() => setTemplates(null));
  }, []);

  // fetchBroadcast returns the raw envelope { broadcast, recipients?, stats? } — unwrap
  // it. Keyed on broadcastId by the caller, so the closure's id is always current.
  const load = useRef(async () => {
    try {
      const { broadcast: fresh, recipients: recs, stats: agg } = await fetchBroadcast(broadcastId);
      setBroadcast(fresh);
      setRecipients(recs ?? null);
      setStats(agg ?? null);
      setState("ok");
    } catch (e) {
      setState((e as { status?: number }).status === 404 ? "notfound" : "error");
    }
  }).current;

  useEffect(() => {
    void load();
  }, [load]);

  // Live: any tenant event (incl. noola.broadcast.updated) refetches this
  // broadcast's tallies. Debounced to coalesce bursts.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribe(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 400);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [subscribe, load]);

  // While mid-send, poll fast so the sent/failed counts climb live even if no
  // event lands. A continuous ("active") broadcast gains recipients on the
  // worker's ~30s matching tick, so it polls too — just gently.
  const pollMs =
    broadcast?.status === "sending"
      ? SEND_POLL_MS
      : broadcast?.status === "active"
        ? ACTIVE_POLL_MS
        : null;
  useEffect(() => {
    if (pollMs == null) return;
    const t = setInterval(() => void load(), pollMs);
    return () => clearInterval(t);
  }, [pollMs, load]);

  if (state === "notfound") {
    return (
      <div className="grid h-full flex-1 place-items-center p-8 text-center">
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <AlertTriangle className="size-7 opacity-40" />
          <p className="text-sm">This broadcast no longer exists.</p>
          <Button variant="outline" size="sm" onClick={onBack}>
            Back to broadcasts
          </Button>
        </div>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="grid h-full flex-1 place-items-center p-8 text-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <AlertTriangle className="size-7 opacity-40" />
          <p className="text-sm">Couldn't load this broadcast.</p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void load()}>
              Try again
            </Button>
            <Button variant="ghost" size="sm" onClick={onBack}>
              Back to broadcasts
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const b = broadcast;
  if (!b) {
    return (
      <div className="grid h-full flex-1 place-items-center py-16">
        <Spinner />
      </div>
    );
  }

  // Recipients: failed-first (delivery problems are what an operator scans for), with a status filter.
  const isRecipFailed = (r: Recipient) => r.status.toLowerCase() === "failed" || !!r.error;
  const sortedRecipients = [...(recipients ?? [])].sort(
    (a, c) => Number(isRecipFailed(c)) - Number(isRecipFailed(a)),
  );
  const recipFailedCount = sortedRecipients.filter(isRecipFailed).length;
  const shownRecipients = sortedRecipients.filter((r) =>
    recipFilter === "all" ? true : recipFilter === "failed" ? isRecipFailed(r) : !isRecipFailed(r),
  );

  // Template is an email fact only; pre-template rows default to "branded".
  const isEmailB = b.channel === "email";
  const tplName = isEmailB ? templateName(b.template_id ?? "branded", templates) : undefined;
  // Draft and scheduled are pre-send — nothing has been delivered, opened, or
  // clicked yet, so the engagement row stays away. Opens/clicks are email-only
  // signals (pixel + wrapped links); chat broadcasts keep delivered/failed only.
  const preSend = b.status === "draft" || b.status === "scheduled";
  const showEngagement = isEmailB && !preSend && stats != null;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {/* ── entity header (§3): back · subject · quiet status · actions ───── */}
      <header className="flex h-12 shrink-0 items-center gap-2 px-4">
        <Link
          to="/broadcasts"
          aria-label="Back to broadcasts"
          className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "size-8 shrink-0 text-muted-foreground")}
        >
          <ChevronLeft className="size-4" />
        </Link>
        <h1 className="min-w-0 truncate text-sm font-semibold tracking-tight">
          {b.subject || "(no subject)"}
        </h1>
        <StatusText status={b.status} />
        {(b.status === "draft" || b.status === "scheduled" || b.status === "active") && (
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {b.status === "draft" && onEdit && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 gap-1.5 text-xs text-muted-foreground"
                onClick={() => onEdit(b)}
              >
                <Pencil className="size-3.5" /> Edit
              </Button>
            )}
            {b.status === "scheduled" && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-xs text-muted-foreground"
                onClick={() => onCancel(b)}
              >
                Cancel schedule
              </Button>
            )}
            {b.status === "active" ? (
              // Stopping is permanent — the routed page confirms before it fires.
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs"
                onClick={() => onCancel(b)}
              >
                <Square className="size-3.5" /> Stop
              </Button>
            ) : (
              // The verb tracks the draft's delivery plan; a scheduled
              // broadcast's "Send now" skips the wait and fires immediately.
              <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={() => onSend(b)}>
                {b.mode === "continuous" ? (
                  <>
                    <Play className="size-3.5" /> Start
                  </>
                ) : b.status === "draft" && b.send_at ? (
                  <>
                    <CalendarClock className="size-3.5" /> Schedule
                  </>
                ) : (
                  <>
                    <Send className="size-3.5" /> Send now
                  </>
                )}
              </Button>
            )}
          </div>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ── main column: the message itself + delivery breakdown ─────────── */}
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-2xl px-6 pb-8 pt-2">
            {/* engagement — aggregates over ALL recipients (not the capped list
                below). Percentages read against delivered; zeroes are honest. */}
            {showEngagement && (
              <section className="mb-6">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Engagement
                </h3>
                <div className={cn("grid grid-cols-2 gap-2", stats.goal ? "sm:grid-cols-4" : "sm:grid-cols-3")}>
                  <EngagementStat label="Delivered" value={stats.delivered} />
                  <EngagementStat
                    label="Opened"
                    value={stats.opened}
                    share={pctOfDelivered(stats.opened, stats.delivered)}
                  />
                  <EngagementStat
                    label="Clicked"
                    value={stats.clicked}
                    share={pctOfDelivered(stats.clicked, stats.delivered)}
                  />
                  {stats.goal && (
                    <EngagementStat
                      label="Goal met"
                      value={stats.goal.conversions}
                      share={pctOfDelivered(stats.goal.conversions, stats.delivered)}
                      sub={`${stats.goal.event} within ${stats.goal.days} ${stats.goal.days === 1 ? "day" : "days"}`}
                    />
                  )}
                </div>
              </section>
            )}

            {/* message preview — a block-composed email renders through the
                send-path renderer (the iframe IS what recipients got, with
                sample merge data); chat/markdown broadcasts keep the read-twin */}
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Message
              </h3>
              {b.channel === "email" && b.blocks && b.blocks.length > 0 ? (
                <BlockMessagePreview broadcast={b} />
              ) : b.body?.trim() ? (
                <ArticleBody markdown={b.body} className="text-sm" />
              ) : (
                <p className="text-sm text-muted-foreground">No body.</p>
              )}
            </section>

            {/* recipients — failed rows carry the only color */}
            {recipients && recipients.length > 0 && (
              <section className="mt-6">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Recipients
                  </h3>
                  <div className="inline-flex rounded-md border p-0.5 text-xs">
                    {(["all", "failed", "sent"] as const).map((k) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setRecipFilter(k)}
                        className={cn(
                          "rounded px-2 py-0.5 font-medium capitalize transition-colors",
                          recipFilter === k ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
                          k === "failed" && recipFailedCount > 0 && recipFilter !== "failed" && "text-destructive",
                        )}
                      >
                        {k}
                        {k === "failed" && recipFailedCount > 0 && (
                          <span className="ml-1 tabular-nums">{recipFailedCount}</span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
                <ul className="divide-y divide-border/50 overflow-hidden rounded-lg border">
                  {/* email rows carry open/click moments, so they earn a quiet
                      header naming the columns; chat rows stay label-free */}
                  {isEmailB && (
                    <li className="flex items-center gap-3 px-4 py-1.5 text-micro font-medium uppercase tracking-wider text-muted-foreground/70">
                      <span aria-hidden className="w-3.5 shrink-0" />
                      <span className="min-w-0 flex-1">Recipient</span>
                      <span className="w-16 shrink-0 text-right">Opened</span>
                      <span className="w-16 shrink-0 text-right">Clicked</span>
                      <span className="w-16 shrink-0 text-right">Status</span>
                    </li>
                  )}
                  {shownRecipients.map((r, i) => {
                    const failed = isRecipFailed(r);
                    return (
                      <li key={`${r.handle}-${i}`} className="flex items-center gap-3 px-4 py-2.5">
                        <ChannelIcon channel={b.channel} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm">{r.handle}</div>
                          {r.error && (
                            <div className="truncate text-micro text-destructive" title={r.error}>
                              {r.error}
                            </div>
                          )}
                        </div>
                        {/* opens/clicks are email-only signals — chat channels have none */}
                        {isEmailB && (
                          <>
                            <EngagementMoment iso={r.opened_at} what="Opened" />
                            <EngagementMoment iso={r.clicked_at} what="Clicked" />
                          </>
                        )}
                        {/* delivered is the norm — only failure earns color (§4) */}
                        <span
                          className={cn(
                            "shrink-0 text-xs capitalize",
                            isEmailB && "w-16 truncate text-right",
                            failed ? "text-destructive" : "text-muted-foreground",
                          )}
                          title={r.status}
                        >
                          {r.status}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {/* facts fall back into the column when the rail is off-canvas (§5) */}
            <section className="mt-6 xl:hidden">
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Delivery
              </h3>
              <BroadcastFacts b={b} templateName={tplName} />
              <h3 className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Audience
              </h3>
              <AudienceFacts segment={b.segment} />
            </section>
          </div>
        </main>

        {/* ── facts rail (§6): tallies pinned, audience as a section ────────── */}
        <aside className="hidden w-72 shrink-0 overflow-y-auto border-l border-border/60 xl:block">
          <div className="px-4 py-3">
            <BroadcastFacts b={b} templateName={tplName} />
          </div>
          <RailSection id="broadcast.audience" icon={Users} title="Audience" defaultOpen>
            <AudienceFacts segment={b.segment} />
          </RailSection>
        </aside>
      </div>
    </div>
  );
}

/** A block-composed email rendered through the send-path renderer — fetched
 *  once per broadcast (blocks are immutable after create) and framed in the
 *  shared preview iframe. If the renderer is unreachable, the server-derived
 *  plaintext body still tells the story. */
function BlockMessagePreview({ broadcast: b }: { broadcast: Broadcast }) {
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    previewBroadcastRender({
      subject: b.subject,
      blocks: b.blocks ?? [],
      ...(b.template_id ? { templateId: b.template_id } : {}),
    })
      .then((p) => {
        if (live) setHtml(p.html);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
    // Content is immutable once created — keying on the id avoids re-rendering
    // the preview every time the mid-send poll refetches the row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [b.id]);

  if (failed) {
    return b.body?.trim() ? (
      <ArticleBody markdown={b.body} className="text-sm" />
    ) : (
      <p className="text-sm text-muted-foreground">The message preview couldn't be rendered.</p>
    );
  }
  return (
    <EmailPreview
      html={html}
      frameHeight={520}
      className="overflow-hidden rounded-xl border bg-muted/30"
    />
  );
}

/** "42%" of delivered — the engagement row's shared denominator. Zero delivered
 *  reads as 0% (an honest zero, not a blank). */
function pctOfDelivered(n: number, delivered: number): string {
  return delivered > 0 ? `${Math.round((n / delivered) * 100)}%` : "0%";
}

/** One engagement figure — count first, its share of delivered beside it,
 *  an optional sub-line naming what was measured (the goal event). */
function EngagementStat({
  label,
  value,
  share,
  sub,
}: {
  label: string;
  value: number;
  share?: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-micro font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-xl font-semibold tabular-nums tracking-tight">
          {value.toLocaleString()}
        </span>
        {share && (
          <span className="text-xs tabular-nums text-muted-foreground" title={`${share} of delivered`}>
            {share}
          </span>
        )}
      </div>
      {sub && (
        <div className="mt-0.5 truncate text-micro text-muted-foreground" title={sub}>
          {sub}
        </div>
      )}
    </div>
  );
}

/** A recipient's open/click moment — relative time when it happened, a quiet
 *  em-dash when it hasn't. Fixed width so the columns stay columns. */
function EngagementMoment({ iso, what }: { iso: string | null; what: string }) {
  if (!iso) {
    return (
      <span aria-label={`Not ${what.toLowerCase()}`} className="w-16 shrink-0 text-right text-xs text-muted-foreground/50">
        —
      </span>
    );
  }
  const d = new Date(iso);
  return (
    <span
      className="w-16 shrink-0 truncate text-right text-xs tabular-nums text-muted-foreground"
      title={Number.isNaN(d.getTime()) ? what : `${what} ${d.toLocaleString()}`}
    >
      {relativeTime(iso)}
    </span>
  );
}

/** Delivery tallies as label/value facts + a slim two-segment meter. Numerals
 *  are mono; failed earns warm red only when > 0 (§4). Rendered in the xl rail
 *  and stacked into the main column below it. */
function BroadcastFacts({ b, templateName }: { b: Broadcast; templateName?: string }) {
  const total = b.recipient_count;
  const pending = Math.max(0, total - b.sent_count - b.failed_count);
  // Draft AND scheduled are pre-send — nothing has been delivered yet, so the
  // tallies and the meter stay away.
  const preSend = b.status === "draft" || b.status === "scheduled";
  const pctOf = (n: number) => (total > 0 ? (n / total) * 100 : 0);
  const abs = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? undefined : d.toLocaleString();
  };

  return (
    <div>
      <dl className="flex flex-col">
        <FactRow label="Channel">
          <span className="inline-flex items-center gap-1.5">
            <ChannelIcon channel={b.channel} />
            {CHANNEL_LABEL[b.channel] ?? b.channel}
          </span>
        </FactRow>
        {templateName && (
          <FactRow label="Template">
            <span className="truncate" title={templateName}>
              {templateName}
            </span>
          </FactRow>
        )}
        {/* the delivery plan — a scheduled fire time, or the continuous mode */}
        {b.mode !== "continuous" && b.send_at && preSend && (
          <FactRow label="Sends">
            <span title={abs(b.send_at)}>{sendTimeWords(b.send_at)}</span>
          </FactRow>
        )}
        {b.mode === "continuous" && (
          <FactRow label="Delivery">
            {b.status === "active" ? (
              <span title="Delivers to each contact the first time they match the audience">
                Started · sends to new matches
              </span>
            ) : (
              <span>Continuous</span>
            )}
          </FactRow>
        )}
        {b.mode === "continuous" && b.stop_at && b.status !== "stopped" && (
          <FactRow label="Stops">
            <span title={abs(b.stop_at)}>{sendTimeWords(b.stop_at)}</span>
          </FactRow>
        )}
        {/* the send window matters while automatic delivery is still ahead
            (draft plan, armed schedule, live continuous) — history omits it */}
        {(preSend || b.status === "active") && windowWords(b) && (
          <FactRow label="Window">
            <span
              className="truncate"
              title="Scheduler-driven deliveries only go out inside this window. Send now bypasses it."
            >
              {windowWords(b)}
            </span>
          </FactRow>
        )}
        {/* the conversion goal rides the draft too — the engagement row only
            takes over once something has been delivered */}
        {b.goal_event && (
          <FactRow label="Goal">
            <span
              className="truncate"
              title={`Counts recipients who do ${b.goal_event} within ${b.goal_days} days of delivery.`}
            >
              {b.goal_event} · {b.goal_days}d
            </span>
          </FactRow>
        )}
        <FactRow label="Recipients">
          <span className="font-mono tabular-nums">{total.toLocaleString()}</span>
        </FactRow>
        {!preSend && (
          <>
            <FactRow label="Delivered">
              <span className="font-mono tabular-nums">{b.sent_count.toLocaleString()}</span>
            </FactRow>
            <FactRow label="Failed">
              <span
                className={cn("font-mono tabular-nums", b.failed_count > 0 && "text-destructive")}
              >
                {b.failed_count.toLocaleString()}
              </span>
            </FactRow>
            {pending > 0 && (
              <FactRow label="Pending">
                <span className="font-mono tabular-nums">{pending.toLocaleString()}</span>
              </FactRow>
            )}
          </>
        )}
        <FactRow label="Created">
          <span title={abs(b.created_at)}>{relativeTime(b.created_at)}</span>
        </FactRow>
        {b.sent_at && (
          <FactRow label="Sent">
            <span title={abs(b.sent_at)}>{relativeTime(b.sent_at)}</span>
          </FactRow>
        )}
      </dl>
      {!preSend && total > 0 && (
        <div
          className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-muted"
          role="img"
          aria-label={`${b.sent_count.toLocaleString()} of ${total.toLocaleString()} delivered`}
        >
          <div
            className="bg-foreground/60 transition-[width] duration-300 ease-[var(--ease-out-strong)]"
            style={{ width: `${pctOf(b.sent_count)}%` }}
          />
          <div
            className="bg-destructive transition-[width] duration-300 ease-[var(--ease-out-strong)]"
            style={{ width: `${pctOf(b.failed_count)}%` }}
          />
        </div>
      )}
    </div>
  );
}

/** The audience the broadcast targeted — each segment clause as a label/value
 *  fact ("All contacts" when unfiltered). */
function AudienceFacts({ segment }: { segment: Segment }) {
  const clauses = segmentClauses(segment);
  if (clauses.length === 0) {
    return <p className="py-1 text-small text-muted-foreground">All contacts</p>;
  }
  return (
    <dl className="flex flex-col">
      {clauses.map((c, i) => (
        <FactRow key={i} label={c.label}>
          <span className="truncate" title={c.value}>
            {c.value}
          </span>
        </FactRow>
      ))}
    </dl>
  );
}
