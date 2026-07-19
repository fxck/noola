import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowUpRight,
  CornerUpLeft,
  Hash,
  Link2,
  MessageSquareText,
  MessagesSquare,
  Plus,
  Tags,
  X,
} from "lucide-react";
import {
  type Ticket,
  type TicketPriority,
  type AgentUser,
  TICKET_PRIORITIES,
  patchTicket,
  assignTicket,
  relativeTime,
} from "@/lib/tickets";
import { type Team, fetchTeams, setTicketTeam } from "@/lib/teams";
import { type CsatResponse, fetchTicketCsat } from "@/lib/csat";
import { fetchContactHistory } from "@/lib/contacts";
import { toast } from "@/components/ui/toaster";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { PRIORITY_META } from "@/components/ticket-priority";
import { SlaBadge } from "@/components/sla-badge";
import { SentimentBadge } from "@/components/sentiment-badge";
import { CsatStars } from "@/components/csat-stars";
import { TicketTypePicker } from "@/components/ticket-type-picker";
import { TicketCustomFields } from "@/components/ticket-custom-fields";
import { RelatedPanel } from "@/components/related-panel";
import { AgentRunsSection } from "@/components/inbox/agent-runs-panel";
import { CopyId } from "@/components/live/nerd-stats";
import { PopoverSelect } from "@/components/ui/menu";
import { Popover } from "@/components/ui/popover";
import { Avatar } from "@/components/ui/avatar";
import { AssigneePicker } from "@/components/inbox/assignee-picker";
import { TeamPicker } from "@/components/inbox/team-picker";
import { Input } from "@/components/ui/input";
import { FactRow, RailSection } from "@/components/ui/rail";
import { cn } from "@/lib/utils";

// The right-hand detail rail — STRUCTURE.md §6, round 4: a pinned block of the
// facts an agent needs at a glance (editable ones open quiet popover pickers),
// then Intercom-style collapsible sections whose open state persists per
// operator. Actions live in the thread header now — the rail is pure context.
export function ContextRail({
  ticket,
  users,
  channels,
  messageCount,
  onMutated,
  focused,
}: {
  ticket: Ticket;
  users: AgentUser[];
  /** distinct channels present in this conversation (omnichannel) — the rail
   *  reports the SET, since post-unification a thread can span more than one */
  channels: string[];
  messageCount: number | null;
  onMutated: () => void;
  focused: boolean;
}) {
  const [t, setT] = useState(ticket);
  useEffect(() => setT(ticket), [ticket]);
  const [savingPriority, setSavingPriority] = useState(false);
  const [savingType, setSavingType] = useState(false);
  const [savingTags, setSavingTags] = useState(false);
  const [savingAssignee, setSavingAssignee] = useState(false);
  const [savingTeam, setSavingTeam] = useState(false);
  const [csat, setCsat] = useState<CsatResponse | null>(null);
  // Team lanes are best-effort chrome — when the tenant has none (or the fetch
  // fails), the Team fact row self-hides like custom fields do.
  const [teams, setTeams] = useState<Team[]>([]);
  useEffect(() => {
    let live = true;
    fetchTeams()
      .then((ts) => live && setTeams(ts))
      .catch(() => live && setTeams([]));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    fetchTicketCsat(ticket.id)
      .then((c) => live && setCsat(c))
      .catch(() => live && setCsat(null));
    return () => {
      live = false;
    };
  }, [ticket.id]);

  async function patch(
    fields: Parameters<typeof patchTicket>[1],
    optimistic: Partial<Ticket>,
  ) {
    const prev = t;
    setT({ ...t, ...optimistic });
    try {
      setT(await patchTicket(ticket.id, fields));
      onMutated();
    } catch {
      setT(prev);
      toast.error("Couldn't save the change.");
    }
  }

  async function setPriority(p: TicketPriority) {
    if (t.priority === p) return;
    setSavingPriority(true);
    await patch({ priority: p }, { priority: p });
    setSavingPriority(false);
  }
  async function setType(typeId: string | null) {
    setSavingType(true);
    await patch({ typeId }, {});
    setSavingType(false);
  }
  async function commitTags(next: string[]) {
    setSavingTags(true);
    await patch({ tags: next }, { tags: next });
    setSavingTags(false);
  }
  async function setTeam(teamId: string | null, autoAssign: boolean) {
    const prev = t;
    const name = teamId ? (teams.find((x) => x.id === teamId)?.name ?? null) : null;
    setT({ ...t, team_id: teamId, team_name: name }); // optimistic
    setSavingTeam(true);
    try {
      const res = await setTicketTeam(ticket.id, teamId, autoAssign);
      // Round-robin may have handed the ticket to a team member — reflect it.
      if (autoAssign) {
        const assignee = res.assigneeId ? (users.find((u) => u.id === res.assigneeId) ?? null) : null;
        setT((cur) => ({
          ...cur,
          assignee_id: res.assigneeId,
          assignee_name: assignee?.name ?? null,
        }));
      }
      onMutated();
    } catch {
      setT(prev);
      toast.error("Couldn't move the ticket to that team.");
    } finally {
      setSavingTeam(false);
    }
  }
  async function setAssignee(id: string | null) {
    const prev = t;
    const name = id ? (users.find((u) => u.id === id)?.name ?? null) : null;
    setT({ ...t, assignee_id: id, assignee_name: name }); // optimistic
    setSavingAssignee(true);
    try {
      await assignTicket(ticket.id, id);
      onMutated();
    } catch {
      setT(prev);
      toast.error("Couldn't reassign the ticket.");
    } finally {
      setSavingAssignee(false);
    }
  }

  const abs = (s: string) => {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? undefined : d.toLocaleString();
  };
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  // Omnichannel: a conversation can span channels — report the SET the messages
  // actually use, falling back to the ticket's origin channel before load.
  const distinctChannels = channels.length > 0 ? channels : [t.channel_type];
  const channelLabel = distinctChannels.map(cap).join(", ");
  const priorityDot = (p: TicketPriority) => (
    <span className={cn("size-2 shrink-0 rounded-full", PRIORITY_META[p].dot)} />
  );

  return (
    <aside
      className={cn(
        "hidden shrink-0 flex-col overflow-y-auto rounded-xl border bg-card shadow-sm",
        focused ? "lg:flex lg:w-80" : "w-72 xl:flex",
      )}
    >
      {/* pane header — h-12, baseline-aligned with the list + thread headers */}
      <div className="flex h-12 shrink-0 items-center border-b border-border/50 px-4">
        <h3 className="text-sm font-semibold tracking-tight">Details</h3>
      </div>

      {/* ── pinned facts — what an agent needs at a glance; editable ones pick in place ── */}
      <dl className="flex flex-col px-4 py-2">
        {t.contact_name && (
          <FactRow label="Contact">
            {t.contact_id ? (
              <Link
                to="/contacts/$contactId"
                params={{ contactId: t.contact_id }}
                className="group/ct flex min-w-0 items-center justify-end gap-1.5 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                title="Open contact"
              >
                <Avatar name={t.contact_name} className="size-4 text-[8px]" />
                <span className="truncate underline-offset-2 group-hover/ct:underline">
                  {t.contact_name}
                </span>
              </Link>
            ) : (
              <span className="flex min-w-0 items-center justify-end gap-1.5">
                <Avatar name={t.contact_name} className="size-4 text-[8px]" />
                <span className="truncate">{t.contact_name}</span>
              </span>
            )}
          </FactRow>
        )}
        {t.company_name && (
          <FactRow label="Company">
            {t.company_id ? (
              <Link
                to="/companies/$companyId"
                params={{ companyId: t.company_id }}
                className="min-w-0 truncate underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                title="Open company"
              >
                {t.company_name}
              </Link>
            ) : (
              <span className="min-w-0 truncate">{t.company_name}</span>
            )}
          </FactRow>
        )}
        <FactRow label="Status">
          <span className="inline-flex items-center gap-1.5">
            <span
              className={cn(
                "size-1.5 rounded-full",
                t.status === "closed" ? "bg-muted-foreground/60" : "bg-success",
              )}
            />
            {t.status === "closed" ? "Closed" : "Open"}
          </span>
        </FactRow>
        <FactRow label="Waiting on">
          {t.whose_turn === "us" ? (
            <span className="inline-flex items-center gap-1 font-medium text-warning">
              <CornerUpLeft className="size-3" /> Needs reply
            </span>
          ) : t.whose_turn === "customer" ? (
            "Customer"
          ) : (
            "—"
          )}
        </FactRow>
        <FactRow label="Assignee">
          <AssigneePicker
            users={users}
            assigneeId={t.assignee_id}
            assigneeName={t.assignee_name}
            busy={savingAssignee}
            onChange={(id) => void setAssignee(id)}
          />
        </FactRow>
        {(teams.length > 0 || t.team_id) && (
          <FactRow label="Team">
            <TeamPicker
              teams={teams}
              teamId={t.team_id ?? null}
              teamName={t.team_name ?? null}
              busy={savingTeam}
              onChange={(id, autoAssign) => void setTeam(id, autoAssign)}
            />
          </FactRow>
        )}
        <FactRow label="Priority">
          <PopoverSelect
            value={t.priority}
            disabled={savingPriority}
            options={TICKET_PRIORITIES.map((p) => ({
              value: p,
              label: PRIORITY_META[p].label,
              dot: priorityDot(p),
            }))}
            onChange={(v) => void setPriority((v ?? "normal") as TicketPriority)}
          />
        </FactRow>
        <TicketTypePicker typeId={t.type_id} saving={savingType} onChange={(id) => void setType(id)} />
        {t.sla && (
          <FactRow label="SLA">
            <SlaBadge sla={t.sla} />
          </FactRow>
        )}
      </dl>

      {/* ── collapsible sections — open state persists per operator ── */}
      <div className="flex-1">
        <RailSection id="attributes" icon={MessageSquareText} title="Conversation attributes" defaultOpen>
          <dl className="flex flex-col">
            <FactRow label={distinctChannels.length > 1 ? "Channels" : "Channel"}>
              {channelLabel}
            </FactRow>
            {/* Discord-origin ticket → deep-link back to the source thread (the forum post it came
                from). Only when we hold both the guild + thread id (mig 0076). */}
            {t.channel_type === "discord" && t.external_guild_id && t.external_thread_id && (
              <FactRow label="Source">
                <a
                  href={`https://discord.com/channels/${t.external_guild_id}/${t.external_thread_id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  View in Discord <ArrowUpRight className="size-3.5" />
                </a>
              </FactRow>
            )}
            <FactRow label="Messages">
              <span className="tabular-nums">{messageCount ?? "—"}</span>
            </FactRow>
            <FactRow label="Opened">
              <span title={abs(t.created_at)}>{relativeTime(t.created_at)}</span>
            </FactRow>
            <FactRow label="Last activity">
              <span title={abs(t.updated_at)}>{relativeTime(t.updated_at)}</span>
            </FactRow>
            {t.sentiment && (
              <FactRow label="Sentiment">
                <SentimentBadge sentiment={t.sentiment} />
              </FactRow>
            )}
            {csat && (
              <FactRow label="CSAT">
                <CsatStars rating={csat.rating} />
              </FactRow>
            )}
            <FactRow label="Ticket ID">
              <CopyId value={ticket.id} className="min-w-0 font-mono text-muted-foreground" />
            </FactRow>
          </dl>
          {csat?.comment && (
            <p className="whitespace-pre-wrap pt-1 text-small text-muted-foreground">
              “{csat.comment}”
            </p>
          )}
          {/* tenant-defined custom fields — self-hides when none configured */}
          <TicketCustomFields ticketId={ticket.id} />
        </RailSection>

        {t.contact_id && (
          <RailSection id="recent" icon={MessagesSquare} title="Recent conversations">
            <RecentConversations contactId={t.contact_id} currentId={ticket.id} />
          </RailSection>
        )}

        <RailSection id="tags" icon={Tags} title="Tags" count={t.tags.length} defaultOpen>
          <TagEditor tags={t.tags} saving={savingTags} onCommit={(next) => void commitTags(next)} />
        </RailSection>

        <AgentRunsSection ticketId={ticket.id} />

        <DiscordMirrorSection ticketId={ticket.id} />

        <RailSection id="related" icon={Link2} title="Related tickets">
          <RelatedPanel ticketId={ticket.id} />
        </RailSection>
      </div>
    </aside>
  );
}

/** The contact's other conversations (omnichannel history) — mounts lazily on
 *  first section open; each row jumps the inbox to that ticket. */
function RecentConversations({ contactId, currentId }: { contactId: string; currentId: string }) {
  const [tickets, setTickets] = useState<Ticket[] | null>(null);

  useEffect(() => {
    let live = true;
    fetchContactHistory(contactId)
      .then((h) => live && setTickets(h.tickets.filter((x) => x.id !== currentId).slice(0, 5)))
      .catch(() => live && setTickets([]));
    return () => {
      live = false;
    };
  }, [contactId, currentId]);

  if (tickets === null)
    return <p className="py-1 text-xs text-muted-foreground/70">Loading…</p>;
  if (tickets.length === 0)
    return <p className="py-1 text-xs text-muted-foreground/70">No other conversations yet.</p>;

  return (
    <ul className="-mx-1.5 flex flex-col">
      {tickets.map((x) => (
        <li key={x.id}>
          <Link
            to="/"
            search={{ ticket: x.id }}
            className="flex items-center gap-2 rounded-md px-1.5 py-1.5 text-small transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                x.status === "closed" ? "bg-muted-foreground/50" : "bg-success",
              )}
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate">{x.subject}</span>
            <span className="shrink-0 text-micro tabular-nums text-muted-foreground">
              {relativeTime(x.updated_at)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Tag chips + a popover adder. Remove affordance appears on hover/focus so the
 *  resting row stays quiet; the add popover stays open for entering several. */
/** Discord ops-mirror rail section — renders ONLY when it has something real to say: a deep link
 *  (mirrored), "mirrors automatically" (auto covers it), or the manual push (binding exists but
 *  the filter doesn't match). No binding / discord-origin / still loading → no section at all;
 *  setup nudges belong in Settings, not on every conversation. */
interface MirrorState {
  mirrored: boolean;
  url: string | null;
  hasBinding?: boolean;
  discordOrigin?: boolean;
  auto?: boolean;
}
function DiscordMirrorSection({ ticketId }: { ticketId: string }) {
  const [state, setState] = useState<MirrorState | null>(null);
  const [pushing, setPushing] = useState(false);

  useEffect(() => {
    setState(null);
    api<MirrorState>(`/tickets/${ticketId}/mirror`)
      .then(setState)
      .catch(() => setState(null));
  }, [ticketId]);

  if (!state || !state.hasBinding || state.discordOrigin) return null;

  return (
    <RailSection id="discord-mirror" icon={Hash} title="Discord">
      <DiscordMirrorPanel state={state} pushing={pushing} setPushing={setPushing} ticketId={ticketId} setState={setState} />
    </RailSection>
  );
}

function DiscordMirrorPanel({
  ticketId,
  state,
  setState,
  pushing,
  setPushing,
}: {
  ticketId: string;
  state: MirrorState;
  setState: (s: MirrorState) => void;
  pushing: boolean;
  setPushing: (v: boolean) => void;
}) {

  async function push() {
    setPushing(true);
    try {
      const res = await api<MirrorState & { url: string }>(`/tickets/${ticketId}/mirror`, { method: "POST", body: "{}" });
      setState({ mirrored: true, url: res.url });
      toast.success("Mirrored to Discord.");
    } catch (err) {
      const reason = (err as { detail?: string }).detail;
      toast.error(
        reason === "no_binding"
          ? "No Discord mirror binding — set one up in Settings → Discord ops mirror."
          : reason === "discord_offline"
            ? "The Discord bot is offline."
            : "Couldn't mirror this ticket.",
      );
    } finally {
      setPushing(false);
    }
  }

  if (state.mirrored && state.url) {
    return (
      <a
        href={state.url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-small text-primary hover:underline"
      >
        Open the forum post <ArrowUpRight className="size-3.5" />
      </a>
    );
  }
  if (state.auto) {
    return (
      <div className="space-y-1.5">
        <p className="text-small text-muted-foreground">
          Mirrors automatically — it'll appear in your management forum shortly.
        </p>
        <button
          type="button"
          className="text-micro text-primary hover:underline disabled:opacity-50"
          onClick={() => void push()}
          disabled={pushing}
        >
          {pushing ? "Mirroring…" : "Mirror now"}
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <Button variant="outline" size="sm" onClick={() => void push()} disabled={pushing}>
        <Hash className="size-3.5" /> {pushing ? "Pushing…" : "Push to Discord"}
      </Button>
      <p className="text-micro text-muted-foreground">
        Doesn't match the auto-mirror filter — pushing creates the forum post anyway.
      </p>
    </div>
  );
}

function TagEditor({
  tags,
  saving,
  onCommit,
}: {
  tags: string[];
  saving: boolean;
  onCommit: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");

  function add() {
    const v = draft.trim();
    if (!v) return;
    if (!tags.includes(v)) onCommit([...tags, v]);
    setDraft("");
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-1", saving && "opacity-60")}>
      {tags.map((tag) => (
        <span
          key={tag}
          className="group/tag inline-flex h-6 items-center gap-0.5 rounded-md bg-muted/70 pl-2 pr-1 text-xs font-medium"
        >
          {tag}
          <button
            type="button"
            onClick={() => onCommit(tags.filter((x) => x !== tag))}
            disabled={saving}
            aria-label={`Remove tag ${tag}`}
            className="rounded-sm p-0.5 text-muted-foreground/50 opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/tag:opacity-100"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setDraft("");
        }}
        align="start"
        width={208}
        trigger={
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="inline-flex h-6 items-center gap-1 rounded-md border border-dashed border-border/80 px-2 text-xs text-muted-foreground transition-colors hover:border-border hover:bg-muted/50 hover:text-foreground"
          >
            <Plus className="size-3" /> {tags.length === 0 ? "Add tag" : "Add"}
          </button>
        }
      >
        <div className="p-2">
          <Input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            placeholder="Tag name…"
            aria-label="New tag name"
            className="h-7 text-xs"
            maxLength={40}
          />
          <p className="pt-1.5 text-micro text-muted-foreground/70">Enter adds — keep typing for more.</p>
        </div>
      </Popover>
    </div>
  );
}
