import { useEffect, useState } from "react";
import { Check, ChevronDown, CircleDashed } from "lucide-react";
import type { Team } from "@/lib/teams";
import { TeamMark } from "@/components/inbox/views-rail";
import { cn } from "@/lib/utils";

/** The team-lane picker — the AssigneePicker idiom: a quiet inline trigger that
 *  reads as a rail value-row, opening a small listbox ("No team" + one row per
 *  team). A footer toggle opts into round-robin auto-assignment: with it on,
 *  picking a team also hands the ticket to one of that team's members. */
export function TeamPicker({
  teams,
  teamId,
  teamName,
  busy,
  onChange,
}: {
  teams: Team[];
  teamId: string | null;
  teamName: string | null;
  busy?: boolean;
  /** `autoAssign` = the round-robin toggle (only meaningful with a real team). */
  onChange: (teamId: string | null, autoAssign: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [autoAssign, setAutoAssign] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const current = teamId ? (teams.find((t) => t.id === teamId) ?? null) : null;

  function pick(id: string | null) {
    setOpen(false);
    if (id !== teamId) onChange(id, id !== null && autoAssign);
  }

  return (
    <div className="relative">
      <button
        type="button"
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          // Quiet inline trigger — reads as a rail value-row, not a button.
          "group/team -my-0.5 flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-small transition-colors hover:bg-muted/60 disabled:opacity-50",
          teamId ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {current ? (
          <TeamMark team={current} />
        ) : (
          <CircleDashed className="size-3.5 shrink-0 text-muted-foreground/60" />
        )}
        <span className="truncate">{teamId ? (current?.name ?? teamName ?? "Team") : "No team"}</span>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground/50 transition-colors group-hover/team:text-muted-foreground" />
      </button>

      {open && (
        <>
          {/* click-away backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div className="motion-pop absolute right-0 z-50 mt-1 w-56 origin-top-right rounded-md border bg-popover text-popover-foreground shadow-md">
            <ul role="listbox" className="max-h-64 overflow-y-auto p-1">
              <Option
                label="No team"
                selected={!teamId}
                onClick={() => pick(null)}
                leading={<CircleDashed className="size-4 shrink-0 text-muted-foreground/60" />}
              />
              {teams.map((team) => (
                <Option
                  key={team.id}
                  label={team.name}
                  sub={`${team.memberCount} ${team.memberCount === 1 ? "member" : "members"}`}
                  selected={teamId === team.id}
                  onClick={() => pick(team.id)}
                  leading={<TeamMark team={team} className="size-5" />}
                />
              ))}
            </ul>
            {/* round-robin opt-in — applies to the next team pick */}
            <label className="flex cursor-pointer items-center gap-2 border-t border-border/60 px-2.5 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground">
              <input
                type="checkbox"
                checked={autoAssign}
                onChange={(e) => setAutoAssign(e.target.checked)}
                className="size-3.5 accent-primary"
              />
              Also assign a member (round-robin)
            </label>
          </div>
        </>
      )}
    </div>
  );
}

function Option({
  label,
  sub,
  selected,
  onClick,
  leading,
}: {
  label: string;
  sub?: string;
  selected: boolean;
  onClick: () => void;
  leading: React.ReactNode;
}) {
  return (
    <li>
      <button
        type="button"
        role="option"
        aria-selected={selected}
        onClick={onClick}
        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
      >
        {leading}
        <span className="min-w-0 flex-1">
          <span className="block truncate">{label}</span>
          {sub && <span className="block truncate text-xs text-muted-foreground">{sub}</span>}
        </span>
        {selected && <Check className="size-4 shrink-0 text-primary" />}
      </button>
    </li>
  );
}
