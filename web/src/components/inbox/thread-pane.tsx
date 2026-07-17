import { Fragment, useEffect, useRef, useState } from "react";
import { ArrowLeft, RotateCcw, ChevronDown, Users } from "lucide-react";
import {
  type Ticket,
  type Message,
  type AgentUser,
  type ReplyChannels,
  fetchMessages,
  assignTicket,
  setTicketOpen,
} from "@/lib/tickets";
import { useQueue } from "@/lib/queue-context";
import { type Note, fetchNotes } from "@/lib/notes";
import { ContextRail } from "@/components/inbox/context-rail";
import { ThreadActions } from "@/components/inbox/thread-actions";
import { AssigneePicker } from "@/components/inbox/assignee-picker";
import { Composer } from "@/components/inbox/composer";
import { MessageBubble, NoteBubble } from "@/components/inbox/message-bubble";
import { AutoreplyPanel } from "@/components/inbox/autoreply-panel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useRealtime } from "@/lib/realtime-context";
import { useNerdMode } from "@/lib/nerd-mode";
import { TicketPresence } from "@/components/live/ticket-presence";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { useLocalFlag } from "@/lib/use-local-flag";
import { cn } from "@/lib/utils";

// ── day separators ───────────────────────────────────────────────────────────
// A conversation that spans days needs the calendar marked — quietly. The label
// is relative while it reads naturally ("Today"/"Yesterday"), then a short
// weekday date ("Mon, Jul 7"), gaining the year only once it isn't this year.

/** Local-calendar-day key — two timestamps share it iff no separator belongs between them. */
function localDayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts);
}

/** Centered hairline row between messages when the thread crosses a calendar day. */
function DaySeparator({ label }: { label: string }) {
  return (
    <li className="flex items-center gap-3">
      <span aria-hidden className="h-px flex-1 bg-border/60" />
      <span className="text-micro text-muted-foreground">{label}</span>
      <span aria-hidden className="h-px flex-1 bg-border/60" />
    </li>
  );
}

/** True when the viewer asked the OS to minimize motion — we then jump instead of spring. */
function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return reduced;
}

export function ThreadPane({
  ticket,
  users,
  refreshKey,
  onBack,
  onMutated,
  focused = false,
}: {
  ticket: Ticket;
  users: AgentUser[];
  refreshKey: number;
  onBack: () => void;
  onMutated: () => void;
  /** Focused single-conversation mode (opened from the table): always show the
   *  Back control, never the inbox list. Off = the inbox two-pane layout. */
  focused?: boolean;
}) {
  const { setPresence } = useRealtime();
  const { nerd } = useNerdMode();
  const { items: queueItems } = useQueue();
  const reduce = usePrefersReducedMotion();
  // A draft waiting for review on this ticket, if any (newest wins).
  const pending = queueItems.find((q) => q.ticket_id === ticket.id) ?? null;
  const [messages, setMessages] = useState<Message[] | null>(null);
  // The reply channels the composer's picker offers (the contact's reachable channels; `current`
  // is the default). Loaded alongside the thread from the messages endpoint.
  const [replyChannels, setReplyChannels] = useState<ReplyChannels | null>(null);
  // Reply-all default (0092): the other recipients on the customer's latest email.
  const [emailCc, setEmailCc] = useState<string[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [loadErr, setLoadErr] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  // Details-rail visibility — an operator preference that sticks (Intercom's
  // "hide right menu"). The responsive classes still gate WHERE it can render.
  const [railOpen, setRailOpen] = useLocalFlag("noola.inbox.rail", true);
  const prevTicketId = useRef<string | null>(null);

  const reloadNotes = useRef((id: string) => {
    fetchNotes(id)
      .then(setNotes)
      .catch(() => setNotes([]));
  }).current;

  const isClosed = ticket.status === "closed";
  const isDiscord = ticket.channel_type === "discord";

  // Presence: broadcast that we're viewing this ticket; clear on leave/switch.
  useEffect(() => {
    setPresence({ viewing: ticket.id });
    return () => setPresence({ viewing: null, typing: null });
  }, [ticket.id, setPresence]);

  async function loadMessages() {
    setLoadErr(false);
    try {
      const { messages: m, channels, emailCc: cc } = await fetchMessages(ticket.id);
      setMessages(m);
      setReplyChannels(channels);
      setEmailCc(cc);
    } catch {
      setLoadErr(true);
    }
  }

  // Load on ticket switch (with a spinner) and on a realtime bump (refreshKey,
  // silently — swap messages in place so a live update doesn't flash a spinner).
  useEffect(() => {
    let cancelled = false;
    if (prevTicketId.current !== ticket.id) {
      prevTicketId.current = ticket.id;
      setMessages(null);
      setLoadErr(false);
    }
    fetchMessages(ticket.id)
      .then(({ messages: m, channels, emailCc: cc }) => {
        if (cancelled) return;
        setMessages(m);
        setReplyChannels(channels);
        setEmailCc(cc);
      })
      .catch(() => !cancelled && setLoadErr(true));
    fetchNotes(ticket.id)
      .then((n) => !cancelled && setNotes(n))
      .catch(() => !cancelled && setNotes([]));
    return () => {
      cancelled = true;
    };
  }, [ticket.id, refreshKey]);

  // One time-ordered stream of the conversation: customer/agent messages interleaved
  // with internal notes (agent-only, never dispatched). Notes carry `_note` so the
  // renderer can pick the right bubble.
  type TimelineItem = (Message & { _note?: false }) | (Note & { _note: true });
  const timeline: TimelineItem[] = [
    ...((messages ?? []) as TimelineItem[]),
    ...notes.map((n) => ({ ...n, _note: true as const })),
  ].sort((a, b) => a.created_at.localeCompare(b.created_at));

  // Omnichannel: only surface a per-message channel badge when the conversation
  // actually spans more than one channel (else it's noise — the header already
  // names the single channel).
  const channels = new Set(
    (messages ?? []).map((m) => m.channel_type).filter((c): c is string => !!c),
  );
  const multiChannel = channels.size > 1;

  async function runAction(fn: () => Promise<void>) {
    setActionBusy(true);
    try {
      await fn();
      onMutated();
    } catch {
      /* parent refetch will reconcile; keep the UI responsive */
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-1 gap-2">
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card shadow-sm">
      {/* pane header — identity only (STRUCTURE.md §5: the rail owns the facts).
          h-12, baseline-aligned with the list pane header. */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-4">
        <Button
          variant="ghost"
          size={focused ? "sm" : "icon"}
          className={cn("-ml-2 shrink-0", !focused && "md:hidden")}
          onClick={onBack}
          aria-label={focused ? "Back to table" : "Back to list"}
        >
          <ArrowLeft />
          {focused && <span className="hidden sm:inline">Back</span>}
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h2 className="min-w-0 truncate text-sm font-semibold tracking-tight">{ticket.subject}</h2>
          {/* no identity meta here — contact + channel are rail facts (§5);
              the subject gets the full header width */}
          {/* live: who else is on this ticket right now */}
          <TicketPresence ticketId={ticket.id} />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* Assignee lives in the rail (§5); below the rail's breakpoint this
              header picker is the responsive fallback so assigning always works. */}
          <div className={focused ? "lg:hidden" : "xl:hidden"}>
            <AssigneePicker
              users={users}
              assigneeId={ticket.assignee_id}
              assigneeName={ticket.assignee_name}
              busy={actionBusy}
              onChange={(id) => runAction(() => assignTicket(ticket.id, id))}
            />
          </div>
          <ThreadActions
            ticket={ticket}
            busy={actionBusy}
            isClosed={isClosed}
            focused={focused}
            railOpen={railOpen}
            onToggleRail={() => setRailOpen(!railOpen)}
            onToggleOpen={() => void runAction(() => setTicketOpen(ticket.id, isClosed))}
            onMutated={onMutated}
          />
        </div>
      </header>

      {/* Community-mode threads are a group chat observed for the record — not a 1:1 workbench
          conversation. Volunteers/mods answer in Discord; there is no agent SLA/queue and the AI
          deflects at most once. Surface that contract so an agent doesn't treat it as their reply. */}
      {ticket.support_mode === "community" && (
        <div className="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-4 py-2 text-micro text-muted-foreground">
          <Users className="size-3.5 shrink-0" aria-hidden />
          <span>
            Community thread — a group conversation answered in-channel. No SLA or agent queue; the
            assistant deflects once, then observes for the record.
          </span>
        </div>
      )}

      {/* nerd: the autoreply decision trail for this ticket */}
      {nerd && <AutoreplyPanel ticketId={ticket.id} refreshKey={refreshKey} />}

      {/* thread — auto-follows the newest message while you're pinned to the bottom,
          releases the lock the instant you scroll up, and offers a jump-back button.
          Keyed by ticket so switching conversations lands you at the latest turn. */}
      <StickToBottom
        key={ticket.id}
        className="relative flex min-h-0 flex-1 flex-col"
        resize={reduce ? "instant" : "smooth"}
        initial={reduce ? "instant" : "smooth"}
      >
        <StickToBottom.Content
          scrollClassName="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6"
          className="flex min-h-full flex-col"
        >
          {messages === null && !loadErr && (
            <div className="grid flex-1 place-items-center">
              <Spinner />
            </div>
          )}
          {loadErr && (
            <div className="grid flex-1 place-items-center gap-2 text-center text-sm text-muted-foreground">
              <p>Couldn't load this conversation.</p>
              <Button variant="outline" size="sm" onClick={() => void loadMessages()}>
                Try again
              </Button>
            </div>
          )}
          {messages && timeline.length === 0 && (
            <div className="grid flex-1 place-items-center text-sm text-muted-foreground">
              No messages in this ticket yet.
            </div>
          )}
          {messages && timeline.length > 0 && (
            <ol className="mx-auto flex w-full max-w-3xl flex-col gap-4">
              {timeline.map((item, i) => {
                // Separators key off the MERGED chronological stream — a note
                // that opens a new day earns the marker like any message.
                const prev = timeline[i - 1];
                const newDay = prev != null && localDayKey(prev.created_at) !== localDayKey(item.created_at);
                const key = item._note ? `note-${item.id}` : item.id;
                return (
                  <Fragment key={key}>
                    {newDay && <DaySeparator label={dayLabel(item.created_at)} />}
                    {item._note ? (
                      <NoteBubble note={item} />
                    ) : (
                      <MessageBubble
                        message={item}
                        showChannel={multiChannel}
                        contactName={ticket.contact_name}
                      />
                    )}
                  </Fragment>
                );
              })}
            </ol>
          )}
        </StickToBottom.Content>
        <JumpToLatest />
      </StickToBottom>

      {/* composer / closed-state footer — the composer renders the held AI
          draft (approve/edit/dismiss) itself, with the thread in view */}
      {isClosed ? (
        <footer className="flex flex-wrap items-center justify-center gap-3 border-t bg-muted/30 px-4 py-4 text-sm text-muted-foreground">
          <span>This conversation is closed.</span>
          <Button
            variant="outline"
            size="sm"
            disabled={actionBusy}
            onClick={() => runAction(() => setTicketOpen(ticket.id, true))}
          >
            <RotateCcw />
            Reopen to reply
          </Button>
        </footer>
      ) : (
        <Composer
          ticket={ticket}
          users={users}
          isDiscord={isDiscord}
          replyChannels={replyChannels}
          defaultCc={emailCc}
          pending={pending}
          onSent={() => void loadMessages()}
          onMutated={onMutated}
          onNoteAdded={() => reloadNotes(ticket.id)}
        />
      )}
      </section>

      {/* right context rail — the ticket's FACTS (actions live in the header).
          Hideable via the header toggle; in the inbox two-pane layout it fills
          the wide-screen gutter (xl+), in focused mode it shows from lg+. */}
      {railOpen && (
        <ContextRail
          ticket={ticket}
          users={users}
          channels={Array.from(channels)}
          messageCount={messages?.length ?? null}
          onMutated={onMutated}
          focused={focused}
        />
      )}
    </div>
  );
}

/** Floating "jump to latest" pill — appears only once you've scrolled up off the
 *  bottom (the stick-to-bottom lock is broken), springs back down on click. Stays
 *  mounted so it can fade in AND out; scale+translate entrance, press feedback. */
function JumpToLatest() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
      <button
        type="button"
        onClick={() => void scrollToBottom()}
        data-visible={!isAtBottom}
        aria-hidden={isAtBottom}
        tabIndex={isAtBottom ? -1 : 0}
        className={cn(
          "pointer-events-auto inline-flex items-center gap-1.5 rounded-full border bg-card/95 px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-lg shadow-black/10 backdrop-blur",
          "transition-[transform,opacity] duration-200 ease-out hover:text-foreground active:scale-[0.97] motion-reduce:transition-none",
          "data-[visible=false]:pointer-events-none data-[visible=false]:translate-y-1 data-[visible=false]:scale-95 data-[visible=false]:opacity-0",
        )}
      >
        <ChevronDown className="size-3.5" /> Jump to latest
      </button>
    </div>
  );
}
