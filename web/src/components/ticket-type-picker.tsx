import { useEffect, useState } from "react";
import { type TicketType, fetchTicketTypes, typeDotClass } from "@/lib/ticket-types";
import { PopoverSelect } from "@/components/ui/menu";
import { cn } from "@/lib/utils";

/** Type picker for the ticket detail rail — a quiet value-row with a popover
 *  picker (STRUCTURE.md §6), never a row of pills. Renders nothing until types
 *  load; hides entirely when the tenant has defined none. */
export function TicketTypePicker({
  typeId,
  saving,
  onChange,
}: {
  typeId: string | null | undefined;
  saving?: boolean;
  onChange: (typeId: string | null) => void;
}) {
  const [types, setTypes] = useState<TicketType[] | null>(null);

  useEffect(() => {
    let live = true;
    fetchTicketTypes()
      .then((t) => live && setTypes(t))
      .catch(() => live && setTypes([]));
    return () => {
      live = false;
    };
  }, []);

  if (!types || types.length === 0) return null;

  const dot = (t: TicketType) => (
    <span className={cn("size-2 shrink-0 rounded-full", typeDotClass(t.color))} />
  );

  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-small">
      <span className="shrink-0 text-muted-foreground">Type</span>
      <PopoverSelect
        value={typeId ?? null}
        disabled={saving}
        placeholder="None"
        options={[
          { value: null, label: "None" },
          ...types.map((t) => ({ value: t.id, label: t.name, dot: dot(t) })),
        ]}
        onChange={onChange}
      />
    </div>
  );
}
