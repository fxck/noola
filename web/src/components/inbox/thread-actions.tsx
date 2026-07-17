import { useState } from "react";
import {
  BookOpen,
  Bot,
  CheckCircle2,
  ChevronLeft,
  Clock,
  GitMerge,
  Lightbulb,
  MoreHorizontal,
  PanelRight,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import type { Ticket } from "@/lib/tickets";
import { Popover } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { SummaryPanel } from "@/components/summary-panel";
import { ArticleDraftPanel } from "@/components/article-draft-panel";
import { AgentRunPanel } from "@/components/agent-run-panel";
import { SnoozePanel } from "@/components/snooze-panel";
import { FeatureLinkPanel } from "@/components/feature-link-panel";
import { MergePanel } from "@/components/merge-panel";
import { cn } from "@/lib/utils";

const ACTIONS = [
  { key: "summary", label: "Summarize thread", icon: Sparkles },
  { key: "kb", label: "Draft KB article", icon: BookOpen },
  { key: "agent", label: "Run AI agent", icon: Bot },
  { key: "feature", label: "Link feature request", icon: Lightbulb },
  { key: "merge", label: "Merge duplicate…", icon: GitMerge },
] as const;
type ActionKey = (typeof ACTIONS)[number]["key"];

/**
 * The thread header's quick-action cluster (Intercom-style): snooze as a
 * first-class action, an overflow menu holding the heavy AI/workflow panels
 * (picking one swaps the popover to that panel in place), close/reopen, and
 * the details-rail visibility toggle. The rail keeps the FACTS; the header
 * owns the ACTIONS.
 */
export function ThreadActions({
  ticket,
  busy,
  isClosed,
  focused = false,
  railOpen,
  onToggleRail,
  onToggleOpen,
  onMutated,
}: {
  ticket: Ticket;
  busy: boolean;
  isClosed: boolean;
  /** Focused (table-opened) mode — the rail renders from lg there, xl in the inbox. */
  focused?: boolean;
  railOpen: boolean;
  onToggleRail: () => void;
  onToggleOpen: () => void;
  onMutated: () => void;
}) {
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [panel, setPanel] = useState<ActionKey | null>(null);
  const snoozed =
    !!ticket.snoozed_until && new Date(ticket.snoozed_until).getTime() > Date.now();

  const iconBtn = "size-8 text-muted-foreground hover:text-foreground";

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {/* snooze */}
      <Popover
        open={snoozeOpen}
        onOpenChange={setSnoozeOpen}
        align="end"
        width={232}
        trigger={
          <Button
            variant="ghost"
            size="icon"
            className={cn(iconBtn, snoozed && "text-primary hover:text-primary")}
            onClick={() => setSnoozeOpen((v) => !v)}
            title={snoozed ? "Snoozed — manage" : "Snooze"}
            aria-label="Snooze"
            aria-expanded={snoozeOpen}
          >
            <Clock />
          </Button>
        }
      >
        <SnoozePanel
          ticket={ticket}
          onSnoozed={() => {
            setSnoozeOpen(false);
            onMutated();
          }}
        />
      </Popover>

      {/* overflow — menu first; a chosen action renders its panel in place */}
      <Popover
        open={moreOpen}
        onOpenChange={(o) => {
          setMoreOpen(o);
          if (!o) setPanel(null);
        }}
        align="end"
        width={panel ? 320 : 208}
        trigger={
          <Button
            variant="ghost"
            size="icon"
            className={cn(iconBtn, moreOpen && "bg-muted text-foreground")}
            onClick={() => {
              setMoreOpen((v) => !v);
              setPanel(null);
            }}
            title="More actions"
            aria-label="More actions"
            aria-expanded={moreOpen}
          >
            <MoreHorizontal />
          </Button>
        }
      >
        {panel === null ? (
          <div className="p-1">
            {ACTIONS.map((a) => (
              <button
                key={a.key}
                type="button"
                onClick={() => setPanel(a.key)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-small transition-colors hover:bg-accent"
              >
                <a.icon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="flex-1">{a.label}</span>
              </button>
            ))}
          </div>
        ) : (
          <div>
            <div className="flex h-9 items-center gap-1 border-b border-border/60 px-1.5">
              <Button
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground"
                onClick={() => setPanel(null)}
                aria-label="Back to actions"
              >
                <ChevronLeft className="size-3.5" />
              </Button>
              <span className="text-xs font-medium">
                {ACTIONS.find((a) => a.key === panel)!.label}
              </span>
            </div>
            <div className="max-h-96 overflow-y-auto p-3">
              {panel === "summary" && <SummaryPanel ticketId={ticket.id} />}
              {panel === "kb" && <ArticleDraftPanel ticketId={ticket.id} />}
              {panel === "agent" && <AgentRunPanel ticketId={ticket.id} onLiveRun={onMutated} />}
              {panel === "feature" && <FeatureLinkPanel ticketId={ticket.id} />}
              {panel === "merge" && <MergePanel ticket={ticket} onMerged={onMutated} />}
            </div>
          </div>
        )}
      </Popover>

      {/* close / reopen */}
      <Button
        variant="ghost"
        size="icon"
        className={iconBtn}
        disabled={busy}
        onClick={onToggleOpen}
        title={isClosed ? "Reopen ticket" : "Close ticket (E)"}
        aria-label={isClosed ? "Reopen ticket" : "Close ticket"}
      >
        {isClosed ? <RotateCcw /> : <CheckCircle2 />}
      </Button>

      {/* details-rail toggle — only where the rail can actually render */}
      <div className={cn("mx-0.5 hidden h-4 w-px bg-border/60", focused ? "lg:block" : "xl:block")} />
      <Button
        variant="ghost"
        size="icon"
        className={cn(iconBtn, focused ? "hidden lg:inline-flex" : "hidden xl:inline-flex", !railOpen && "text-foreground")}
        onClick={onToggleRail}
        title={railOpen ? "Hide details" : "Show details"}
        aria-label={railOpen ? "Hide details" : "Show details"}
        aria-pressed={!railOpen}
      >
        <PanelRight />
      </Button>
    </div>
  );
}
