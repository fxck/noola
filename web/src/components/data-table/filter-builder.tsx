import { useState, type ComponentType } from "react";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover } from "@/components/ui/popover";
import { CommandMenu, type ComboOption } from "@/components/ui/combobox";
import {
  type FilterCondition,
  type FilterFieldDef,
  OPS_BY_TYPE,
  OP_LABEL,
  EVENT_OP_LABEL,
  VALUELESS_OPS,
  conditionLabel,
} from "./types";

/** A filterable field, enriched for the builder: an icon + optional known values (with
 *  counts) that back the value picker. Custom attributes are passed as `attr:<key>` fields.
 *  An `event`-typed field is a PROMPT: picking it asks for the event name and creates a
 *  condition on `event:<typed>` (there is no cheap distinct-event-names source). */
export interface BuilderFieldDef extends FilterFieldDef {
  icon?: ComponentType<{ className?: string }>;
  options?: ComboOption[];
}

// The server accepts at most 10 OR groups of 25 conditions each.
const MAX_GROUPS = 10;

let _seq = 0;
const newId = (): string => `c${++_seq}`;

/** Resolve a condition's field def. `event:<name>` conditions have no per-name entry in
 *  `fields` (they're minted from the event prompt), so they resolve to a synthetic def
 *  that inherits the prompt field's icon. */
function fieldOf(fields: BuilderFieldDef[], key: string): BuilderFieldDef | undefined {
  const f = fields.find((x) => x.key === key);
  if (f) return f;
  if (key.startsWith("event:")) {
    const prompt = fields.find((x) => x.type === "event");
    return { key, label: key.slice(6), type: "event", icon: prompt?.icon };
  }
  return undefined;
}

/**
 * The Intercom-style condition builder, now with OR groups: each chip-row is one group
 * whose conditions AND together; rows OR together (a small "or" separator marks the
 * seam). Each chip opens an editor (operator list + a value input that suggests known
 * values with their counts). Produces `FilterCondition[][]`; the parent maps that to the
 * API via splitFilterGroups (contacts sends `filters`/`filterGroups`; broadcast targeting
 * the segment's `conditions`/`conditionGroups`).
 */
export function FilterBuilder({
  fields,
  groups,
  onChange,
}: {
  fields: BuilderFieldDef[];
  groups: FilterCondition[][];
  onChange: (next: FilterCondition[][]) => void;
}) {
  // Which group's add-popover is open; -1 = none. The event-name prompt lives
  // inside the same popover (picking "Event…" swaps the list for an input).
  const [addingIn, setAddingIn] = useState(-1);
  const [eventName, setEventName] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  // Never render zero rows — an empty builder is one empty group.
  const shown = groups.length > 0 ? groups : [[]];
  const total = shown.reduce((n, g) => n + g.length, 0);

  function closeAdd() {
    setAddingIn(-1);
    setEventName(null);
  }

  function addCondition(gi: number, field: string) {
    const def = fieldOf(fields, field);
    const op = (def?.ops ?? OPS_BY_TYPE[def?.type ?? "text"])[0];
    const id = newId();
    onChange(
      shown.map((g, i) =>
        i === gi
          ? [...g, { id, field, op, value: VALUELESS_OPS.has(op) ? undefined : "" }]
          : g,
      ),
    );
    closeAdd();
    setOpenId(id); // open the editor immediately, like Intercom
  }

  function pickField(gi: number, key: string) {
    const f = fields.find((x) => x.key === key);
    if (!f) return;
    if (f.type === "event") {
      // The event field is a prompt — ask for the name, then mint event:<name>.
      setEventName("");
      return;
    }
    addCondition(gi, key);
  }

  function commitEventName(gi: number) {
    const name = (eventName ?? "").trim();
    if (!name) return;
    addCondition(gi, `event:${name}`);
  }

  function update(id: string, patch: Partial<FilterCondition>) {
    onChange(shown.map((g) => g.map((c) => (c.id === id ? { ...c, ...patch } : c))));
  }

  function remove(id: string) {
    // Dropping a group's last condition drops the group; an emptied builder
    // collapses back to one empty row.
    const next = shown.map((g) => g.filter((c) => c.id !== id)).filter((g) => g.length > 0);
    onChange(next.length > 0 ? next : [[]]);
    if (openId === id) setOpenId(null);
  }

  function addGroup() {
    onChange([...shown, []]);
    setEventName(null);
    setAddingIn(shown.length); // straight into picking the new group's first field
  }

  const fieldOptions: ComboOption[] = fields.map((f) => ({ value: f.key, label: f.label, icon: f.icon }));
  const lastGroup = shown[shown.length - 1] ?? [];
  const canOr = total > 0 && lastGroup.length > 0 && shown.length < MAX_GROUPS;

  return (
    <div className="flex flex-col gap-1.5">
      {shown.map((conditions, gi) => (
        <div key={gi} className="flex flex-wrap items-center gap-1.5">
          {/* the seam between OR-ed rows — quiet, but unmissable */}
          {gi > 0 && (
            <span className="text-micro font-semibold uppercase tracking-wider text-muted-foreground">
              or
            </span>
          )}
          {conditions.map((c) => {
            const f = fieldOf(fields, c.field);
            const Icon = f?.icon;
            return (
              <span key={c.id} className="inline-flex items-center rounded-md border bg-card text-xs">
                <Popover
                  open={openId === c.id}
                  onOpenChange={(o) => setOpenId(o ? c.id : null)}
                  width={264}
                  trigger={
                    <button
                      type="button"
                      onClick={() => setOpenId(openId === c.id ? null : c.id)}
                      className="flex items-center gap-1.5 rounded-l-md py-1 pl-2.5 pr-1.5 hover:bg-muted/60"
                    >
                      {Icon && <Icon className="size-3.5 text-muted-foreground" />}
                      <span className="whitespace-nowrap">{conditionLabel(c, fields)}</span>
                    </button>
                  }
                >
                  <ConditionEditor
                    field={f}
                    cond={c}
                    onChange={(patch) => update(c.id, patch)}
                    onDone={() => setOpenId(null)}
                  />
                </Popover>
                <button
                  type="button"
                  onClick={() => remove(c.id)}
                  aria-label="Remove filter"
                  className="grid self-stretch place-items-center rounded-r-md border-l px-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </span>
            );
          })}

          <Popover
            open={addingIn === gi}
            onOpenChange={(o) => (o ? setAddingIn(gi) : closeAdd())}
            width={220}
            trigger={
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1 border-dashed px-2 text-xs"
                onClick={() => (addingIn === gi ? closeAdd() : setAddingIn(gi))}
              >
                <Plus className="size-3.5" /> Add filter
              </Button>
            }
          >
            {eventName === null ? (
              <CommandMenu
                options={fieldOptions}
                selected={new Set()}
                onToggle={(key) => pickField(gi, key)}
                searchPlaceholder="Filter by…"
              />
            ) : (
              <div className="space-y-1.5 p-2">
                <p className="text-xs text-muted-foreground">Filter by an event the contact did.</p>
                <input
                  autoFocus
                  value={eventName}
                  onChange={(e) => setEventName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitEventName(gi);
                    }
                  }}
                  placeholder="signed_up"
                  className="h-8 w-full rounded-md border border-input bg-background px-2 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <div className="flex items-center justify-end gap-2 pt-0.5">
                  <button
                    type="button"
                    onClick={() => setEventName(null)}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={() => commitEventName(gi)}
                    disabled={!(eventName ?? "").trim()}
                    className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
                  >
                    Add
                  </button>
                </div>
              </div>
            )}
          </Popover>

          {/* trailing controls live on the last row only */}
          {gi === shown.length - 1 && (
            <>
              {canOr && (
                <button
                  type="button"
                  onClick={addGroup}
                  className="text-xs font-medium text-muted-foreground hover:text-foreground"
                  title="Match this row's filters OR another set"
                >
                  + Or
                </button>
              )}
              {total > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    onChange([[]]);
                    setOpenId(null);
                    closeAdd();
                  }}
                  className="ml-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  Clear
                </button>
              )}
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function ConditionEditor({
  field,
  cond,
  onChange,
  onDone,
}: {
  field: BuilderFieldDef | undefined;
  cond: FilterCondition;
  onChange: (patch: Partial<FilterCondition>) => void;
  onDone: () => void;
}) {
  const ops = field ? field.ops ?? OPS_BY_TYPE[field.type] : [];
  const isEvent = field?.type === "event";
  return (
    <div className="w-full p-1">
      {ops.map((op) => {
        const active = cond.op === op;
        const needsValue = !VALUELESS_OPS.has(op);
        return (
          <div key={op}>
            <button
              type="button"
              onClick={() => onChange({ op, value: needsValue ? cond.value ?? "" : undefined })}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                active && "font-medium",
              )}
            >
              <span
                className={cn(
                  "grid size-3.5 shrink-0 place-items-center rounded-full border",
                  active ? "border-primary" : "border-input",
                )}
              >
                {active && <span className="size-1.5 rounded-full bg-primary" />}
              </span>
              {field?.opLabels?.[op] ?? (isEvent ? EVENT_OP_LABEL[op] : undefined) ?? OP_LABEL[op]}
            </button>
            {active && needsValue && (
              <div className="px-2 pb-2 pt-1">
                <ValueEditor field={field} isDate={op === "before" || op === "after"} value={cond.value ?? ""} onChange={(v) => onChange({ value: v })} onEnter={onDone} />
              </div>
            )}
          </div>
        );
      })}
      <div className="border-t px-2 py-1.5 text-right">
        <button type="button" onClick={onDone} className="text-xs font-medium text-primary hover:underline">
          Done
        </button>
      </div>
    </div>
  );
}

function ValueEditor({
  field,
  isDate,
  value,
  onChange,
  onEnter,
}: {
  field: BuilderFieldDef | undefined;
  isDate: boolean;
  value: string;
  onChange: (v: string) => void;
  onEnter: () => void;
}) {
  const suggestions =
    !isDate && field?.options
      ? field.options.filter((o) => !value || o.label.toLowerCase().includes(value.toLowerCase())).slice(0, 20)
      : [];
  return (
    <div className="space-y-1.5">
      <input
        type={isDate ? "date" : "text"}
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onEnter();
          }
        }}
        placeholder="Value…"
        className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      {suggestions.length > 0 && (
        <div className="max-h-32 overflow-y-auto rounded-md border bg-card/50">
          {suggestions.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => onChange(o.value)}
              className="flex w-full items-center justify-between gap-2 px-2 py-1 text-left text-xs hover:bg-accent"
            >
              <span className="truncate">{o.label}</span>
              {o.hint != null && o.hint !== "" && (
                <span className="shrink-0 tabular-nums text-muted-foreground">{o.hint}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
