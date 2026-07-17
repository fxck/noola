import { useEffect, useState } from "react";
import { toast } from "@/components/ui/toaster";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { PopoverSelect } from "@/components/ui/menu";
import {
  type CustomFieldDef,
  fetchFieldDefs,
  fetchTicketValues,
  setTicketValue,
} from "@/lib/custom-fields";

/** The custom-fields editor on a ticket detail — quiet label/value rows that
 *  slot into the rail's attributes section (no heading of its own). Renders
 *  nothing when the tenant has defined no fields. */
export function TicketCustomFields({ ticketId }: { ticketId: string }) {
  const [defs, setDefs] = useState<CustomFieldDef[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    Promise.all([fetchFieldDefs(), fetchTicketValues(ticketId)])
      .then(([d, v]) => {
        if (!live) return;
        setDefs(d);
        setValues(v);
      })
      .catch(() => live && setDefs([]));
    return () => {
      live = false;
    };
  }, [ticketId]);

  async function save(fieldId: string, value: string) {
    const prev = values[fieldId] ?? "";
    if (prev === value) return;
    setValues((v) => ({ ...v, [fieldId]: value })); // optimistic
    try {
      await setTicketValue(ticketId, fieldId, value);
    } catch {
      setValues((v) => ({ ...v, [fieldId]: prev }));
      toast.error("Couldn't save the field.");
    }
  }

  if (defs === null) {
    return (
      <div className="grid place-items-center py-2">
        <Spinner className="size-4" />
      </div>
    );
  }
  if (defs.length === 0) return null;

  return (
    <dl className="flex flex-col">
      {defs.map((d) => (
        <div key={d.id} className="flex items-center justify-between gap-3 py-1 text-small">
          <dt className="min-w-0 truncate text-muted-foreground" title={d.label}>
            {d.label}
          </dt>
          <dd className="flex min-w-0 shrink-0 justify-end">
            <FieldControl def={d} value={values[d.id] ?? ""} onSave={(v) => void save(d.id, v)} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function FieldControl({
  def,
  value,
  onSave,
}: {
  def: CustomFieldDef;
  value: string;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  if (def.field_type === "boolean") {
    const on = value === "true";
    return <Switch checked={on} onCheckedChange={() => onSave(on ? "" : "true")} />;
  }

  if (def.field_type === "select") {
    return (
      <PopoverSelect
        value={value || null}
        placeholder="—"
        options={[{ value: null, label: "—" }, ...def.options.map((o) => ({ value: o, label: o }))]}
        onChange={(v) => onSave(v ?? "")}
      />
    );
  }

  const inputType =
    def.field_type === "number" ? "number" : def.field_type === "date" ? "date" : "text";
  return (
    <Input
      type={inputType}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onSave(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
      }}
      placeholder="—"
      className="h-7 w-28 border-none bg-transparent text-right text-small shadow-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/50 focus-visible:ring-1"
    />
  );
}
