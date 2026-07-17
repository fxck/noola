import type { ReactNode } from "react";
import { Inbox, CornerUpLeft, ListChecks, CircleDashed, UserCheck, CheckCircle2, type LucideIcon } from "lucide-react";
import { type ViewKey, avatarHue } from "@/lib/tickets";
import type { Team } from "@/lib/teams";
import { cn } from "@/lib/utils";

export const VIEWS: { key: ViewKey; label: string; icon: LucideIcon }[] = [
  { key: "all", label: "Open", icon: Inbox },
  { key: "needs_reply", label: "Needs reply", icon: CornerUpLeft },
  { key: "approval", label: "Needs approval", icon: ListChecks },
  { key: "unassigned", label: "Unassigned", icon: CircleDashed },
  { key: "my", label: "Mine", icon: UserCheck },
  { key: "closed", label: "Closed", icon: CheckCircle2 },
];

/** A team's identity mark — its emoji when set, else a small hue dot derived
 *  from the name (the avatar formula, so a team's color is stable app-wide). */
export function TeamMark({ team, className }: { team: Team; className?: string }) {
  if (team.emoji)
    return (
      <span className={cn("grid size-4 shrink-0 place-items-center text-small leading-none", className)} aria-hidden>
        {team.emoji}
      </span>
    );
  return (
    <span className={cn("grid size-4 shrink-0 place-items-center", className)} aria-hidden>
      <span className="size-2 rounded-full" style={{ backgroundColor: `hsl(${avatarHue(team.name)} 42% 45%)` }} />
    </span>
  );
}

/** One View button — shared by the desktop rail and the mobile chip bar. */
function ViewItem({
  label,
  icon: Icon,
  leading,
  count,
  active,
  emphasize,
  onClick,
  chip,
}: {
  label: string;
  icon?: LucideIcon;
  /** Non-icon identity mark (team emoji / hue dot) — used when `icon` is absent. */
  leading?: ReactNode;
  count: number;
  active: boolean;
  emphasize?: boolean;
  onClick: () => void;
  chip?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        // Weight never changes with state — a bolder active label grows wider and
        // wraps the row; the fill alone carries "active".
        "flex items-center gap-2 rounded-md text-small transition-colors",
        chip ? "shrink-0 px-3 py-1.5" : "w-full min-w-0 px-2.5 py-1.5",
        active
          ? chip
            ? "bg-card text-foreground shadow-sm"
            : // on the card panel, active = quiet muted fill (no shadow-on-card)
              "bg-muted text-foreground"
          : cn(
              "text-muted-foreground hover:text-foreground",
              chip ? "hover:bg-card/70" : "hover:bg-muted/60",
            ),
      )}
    >
      {Icon ? (
        <Icon className={cn("size-4 shrink-0", emphasize && count > 0 && !active && "text-warning")} />
      ) : (
        leading
      )}
      <span className={cn("truncate", chip ? "" : "min-w-0 flex-1 text-left")}>{label}</span>
      {/* Quiet count — plain tabular text, no pill (STRUCTURE.md §4). */}
      {count > 0 && (
        <span
          className={cn(
            "ml-1 shrink-0 text-xs tabular-nums",
            emphasize ? "font-medium text-warning" : "text-muted-foreground",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

/** The inbox Views column — an INTERNAL column of the one Inbox panel (views |
 *  list share a single card, divided by a hairline), never a sibling card of
 *  its own. Surface-local navigation belongs INSIDE its surface. Below the
 *  fixed views, each team is a lane of its own (a team acts as its own view —
 *  selecting one clears the fixed-view selection and vice versa). */
export function ViewsRail({
  view,
  counts,
  onSelect,
  teams = [],
  teamCounts = {},
  activeTeamId = null,
  onSelectTeam,
}: {
  view: ViewKey;
  counts: Record<ViewKey, number>;
  onSelect: (v: ViewKey) => void;
  /** Team lanes ([] / omitted = no Teams section at all). */
  teams?: Team[];
  /** Open-ticket count per team id, live from the fetched rows. */
  teamCounts?: Record<string, number>;
  activeTeamId?: string | null;
  onSelectTeam?: (teamId: string) => void;
}) {
  return (
    <nav className="hidden w-44 shrink-0 flex-col border-r border-border/60 md:flex">
      <div className="flex h-12 shrink-0 items-center px-3">
        <h2 className="text-sm font-semibold tracking-tight">Inbox</h2>
      </div>
      <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2 pt-0.5">
        {VIEWS.map((v) => (
          <ViewItem
            key={v.key}
            label={v.label}
            icon={v.icon}
            count={counts[v.key]}
            active={view === v.key && !activeTeamId}
            emphasize={v.key === "needs_reply" || v.key === "approval"}
            onClick={() => onSelect(v.key)}
          />
        ))}
        {teams.length > 0 && (
          <>
            <div className="px-2.5 pb-1 pt-3 text-micro font-medium uppercase tracking-wider text-muted-foreground/70">
              Teams
            </div>
            {teams.map((team) => (
              <ViewItem
                key={team.id}
                label={team.name}
                leading={<TeamMark team={team} />}
                count={teamCounts[team.id] ?? 0}
                active={activeTeamId === team.id}
                onClick={() => onSelectTeam?.(team.id)}
              />
            ))}
          </>
        )}
      </div>
    </nav>
  );
}

/** Horizontal, scrollable View chips for narrow screens (rail is hidden there).
 *  Team lanes ride along as chips after the fixed views. */
export function ViewsChips({
  view,
  counts,
  onSelect,
  teams = [],
  teamCounts = {},
  activeTeamId = null,
  onSelectTeam,
}: {
  view: ViewKey;
  counts: Record<ViewKey, number>;
  onSelect: (v: ViewKey) => void;
  teams?: Team[];
  teamCounts?: Record<string, number>;
  activeTeamId?: string | null;
  onSelectTeam?: (teamId: string) => void;
}) {
  return (
    <div className="flex gap-1.5 overflow-x-auto border-b bg-card/40 px-3 py-2 md:hidden">
      {VIEWS.map((v) => (
        <ViewItem
          key={v.key}
          chip
          label={v.label}
          icon={v.icon}
          count={counts[v.key]}
          active={view === v.key && !activeTeamId}
          emphasize={v.key === "needs_reply" || v.key === "approval"}
          onClick={() => onSelect(v.key)}
        />
      ))}
      {teams.map((team) => (
        <ViewItem
          key={team.id}
          chip
          label={team.name}
          leading={<TeamMark team={team} />}
          count={teamCounts[team.id] ?? 0}
          active={activeTeamId === team.id}
          onClick={() => onSelectTeam?.(team.id)}
        />
      ))}
    </div>
  );
}
