import { Link } from "@tanstack/react-router";
import { MessagesSquare, Table2 } from "lucide-react";
import { cn } from "@/lib/utils";

// The Inbox is one entity with two renderings of the same tickets: a
// conversation workspace (`/`) and a management table (`/tickets`). This
// compact icon segmented control flips between them and lives in ONE fixed
// slot — the right side of the list pane header — on both renderings
// (STRUCTURE.md §3: same control, same place, every view).
const ITEM =
  "grid size-7 place-items-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const ON = "bg-background text-foreground shadow-sm";
const OFF = "text-muted-foreground hover:text-foreground";

export function InboxViewSwitch({ current }: { current: "conversation" | "table" }) {
  return (
    <div
      className="inline-flex items-center rounded-lg bg-muted p-0.5"
      role="tablist"
      aria-label="Inbox view"
    >
      <Link
        to="/"
        role="tab"
        aria-selected={current === "conversation"}
        title="Conversation view"
        aria-label="Conversation view"
        className={cn(ITEM, current === "conversation" ? ON : OFF)}
      >
        <MessagesSquare className="size-3.5" />
      </Link>
      <Link
        to="/tickets"
        role="tab"
        aria-selected={current === "table"}
        title="Table view"
        aria-label="Table view"
        className={cn(ITEM, current === "table" ? ON : OFF)}
      >
        <Table2 className="size-3.5" />
      </Link>
    </div>
  );
}
