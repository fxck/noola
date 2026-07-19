import { ChevronUp, ChevronsUp, CornerUpLeft, UserRound } from "lucide-react";
import { type Ticket, type TicketPriority, relativeTime } from "@/lib/tickets";
import { Avatar } from "@/components/ui/avatar";
import { avatarSrc } from "@/lib/avatar-upload";
import { SlaBadge } from "@/components/sla-badge";
import { cn } from "@/lib/utils";

// One list row, STRUCTURE.md §4 — chips are banned. State renders as weight,
// dots, tiny icons and avatars:
//   [avatar] subject (semibold+dot when unread)          [sla-if-urgent] [time]
//            contact · muted                [needs-reply] [prio] [channel] [assignee]

// Priority only earns a glyph when it changes triage order — urgent (red) and
// high (amber). Normal/low stay silent so the signal means something.
function PriorityGlyph({ priority }: { priority: TicketPriority }) {
  if (priority === "urgent")
    return <ChevronsUp className="size-3.5 shrink-0 text-destructive" aria-label="Urgent priority" />;
  if (priority === "high")
    return <ChevronUp className="size-3.5 shrink-0 text-warning" aria-label="High priority" />;
  return null;
}

/** SLA is silent until it matters (at-risk / breached) — and a closed ticket's
 *  breach is history, not a call to action, so closed rows stay quiet too. */
function slaUrgent(t: Ticket): boolean {
  const s = t.sla;
  if (!s || t.status === "closed") return false;
  return [s.firstResponse.state, s.resolution.state].some(
    (x) => x === "breached" || x === "at_risk",
  );
}

export function TicketRow({
  ticket,
  selected,
  onClick,
  nerd = false,
  pulsing = false,
  unread = false,
}: {
  ticket: Ticket;
  selected: boolean;
  onClick: () => void;
  /** Nerd mode — reveal per-row instrumentation. */
  nerd?: boolean;
  /** A live event just touched this ticket — flash a pulse dot. */
  pulsing?: boolean;
  /** The current agent hasn't read the latest customer message — bolder subject + a dot. */
  unread?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "group relative flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors",
        "hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        selected && "bg-muted/70",
      )}
    >
      {/* the Noola scan-bar — an amber spine that slides in from the left on hover,
          steady when selected. The signature row-identity moment, shared across lists. */}
      <span
        className={cn(
          "absolute inset-y-0 left-0 w-0.5 origin-left bg-primary transition-[opacity,transform] duration-100 ease-[var(--ease-out-strong)]",
          selected
            ? "scale-x-100 opacity-100"
            : "scale-x-0 opacity-0 group-hover:scale-x-100 group-hover:opacity-100",
        )}
      />

      {ticket.contact_name ? (
        <Avatar name={ticket.contact_name} image={avatarSrc(ticket.contact_avatar_url)} className="mt-0.5 size-6 shrink-0 text-micro" />
      ) : (
        // No contact identity — a neutral disc, never a loud hashed hue.
        <span
          className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground/60"
          aria-hidden
        >
          <UserRound className="size-3" />
        </span>
      )}

      <span className="min-w-0 flex-1">
        {/* line 1 — WHO (contact · company) + urgency + time */}
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 truncate text-small font-medium leading-5">
            {ticket.contact_name ||
              ticket.channel_type.charAt(0).toUpperCase() + ticket.channel_type.slice(1)}
          </span>
          {ticket.company_name && (
            <span className="min-w-0 shrink-[2] truncate text-small leading-5 text-muted-foreground">
              · {ticket.company_name}
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {slaUrgent(ticket) && <SlaBadge sla={ticket.sla} compact />}
            {pulsing && (
              <span className="relative flex size-1.5" title="live activity just now" aria-hidden>
                <span className="nerd-in absolute inline-flex size-full rounded-full bg-success/60" />
                <span className="relative inline-flex size-1.5 rounded-full bg-success" />
              </span>
            )}
            <span className="text-micro tabular-nums text-muted-foreground">
              {relativeTime(ticket.updated_at)}
            </span>
          </span>
        </span>

        {/* line 2 — WHAT (weight carries unread) */}
        <span className="flex items-center gap-1.5">
          <span
            className={cn(
              "truncate text-small leading-5",
              unread ? "font-semibold text-foreground" : "text-foreground/90",
            )}
          >
            {ticket.subject}
          </span>
          {unread && (
            <span
              className="size-1.5 shrink-0 rounded-full bg-primary"
              title="Unread — new customer message"
              aria-label="unread"
            />
          )}
        </span>

        {/* line 3 — latest-message snippet + the quiet triage cluster. Short threads
            often have subject === first message; suppress the echo so rows don't stutter. */}
        <span className="mt-px flex items-center gap-1.5">
          <span className="min-h-4 flex-1 truncate text-xs leading-4 text-muted-foreground">
            {ticket.preview && ticket.preview.trim() !== ticket.subject.trim() ? ticket.preview : ""}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {nerd && ticket.message_count != null && (
              <span
                className="font-mono text-micro tabular-nums text-muted-foreground/70"
                title="messages in this thread"
              >
                {ticket.message_count}
              </span>
            )}
            {ticket.whose_turn === "us" && (
              <CornerUpLeft
                className="size-3.5 shrink-0 text-muted-foreground/70"
                aria-label="Needs reply"
              />
            )}
            <PriorityGlyph priority={ticket.priority} />
            {ticket.assignee_id && (
              <Avatar
                name={ticket.assignee_name}
                image={avatarSrc(ticket.assignee_avatar_url)}
                className="size-4 text-[8px]"
              />
            )}
          </span>
        </span>
      </span>
    </button>
  );
}
