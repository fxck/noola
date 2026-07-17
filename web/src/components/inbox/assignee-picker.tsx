import { useEffect, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { AgentUser } from "@/lib/tickets";
import { Avatar } from "@/components/ui/avatar";
import { avatarSrc } from "@/lib/avatar-upload";
import { cn } from "@/lib/utils";

export function AssigneePicker({
  users,
  assigneeId,
  assigneeName,
  busy,
  onChange,
}: {
  users: AgentUser[];
  assigneeId: string | null;
  assigneeName: string | null;
  busy?: boolean;
  onChange: (assigneeId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function pick(id: string | null) {
    setOpen(false);
    if (id !== assigneeId) onChange(id);
  }

  const assignee = assigneeId ? users.find((u) => u.id === assigneeId) : undefined;

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
          "group/asg -my-0.5 flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-small transition-colors hover:bg-muted/60 disabled:opacity-50",
          assigneeId ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {assigneeId ? (
          <Avatar name={assigneeName} image={avatarSrc(assignee?.avatar_url)} className="size-4 text-[8px]" />
        ) : (
          <Avatar unassigned className="size-4" />
        )}
        <span className="truncate">{assigneeId ? assigneeName : "Unassigned"}</span>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground/50 transition-colors group-hover/asg:text-muted-foreground" />
      </button>

      {open && (
        <>
          {/* click-away backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <ul
            role="listbox"
            className="motion-pop absolute right-0 z-50 mt-1 max-h-72 w-52 origin-top-right overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
          >
            <Option
              label="Unassigned"
              selected={!assigneeId}
              onClick={() => pick(null)}
              leading={<Avatar unassigned className="size-5" />}
            />
            {users.map((u) => (
              <Option
                key={u.id}
                label={u.name}
                sub={u.role}
                selected={assigneeId === u.id}
                onClick={() => pick(u.id)}
                leading={<Avatar name={u.name} image={avatarSrc(u.avatar_url)} className="size-5 text-[9px]" />}
              />
            ))}
          </ul>
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
          {sub && <span className="block truncate text-xs capitalize text-muted-foreground">{sub}</span>}
        </span>
        {selected && <Check className="size-4 shrink-0 text-primary" />}
      </button>
    </li>
  );
}
