import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PopoverSelect } from "@/components/ui/menu";
import { cn } from "@/lib/utils";
import {
  type FilterCondition,
  type FilterFieldDef,
  type FilterOp,
  OPS_BY_TYPE,
  OP_LABEL,
  VALUELESS_OPS,
  conditionLabel,
} from "./types";

// Compact input-mirroring trigger for the composer's pickers — matches the sibling
// h-8 text-xs Inputs (the min-width comes per usage).
const SELECT_TRIGGER =
  "my-0 h-8 w-full justify-between rounded-md border border-input bg-background px-3 py-1 text-xs font-normal shadow-sm hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function newId(): string {
  // Browser-native; unique enough to key a chip.
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
}

/** The filter builder: active conditions as removable chips + an inline composer to add
 *  one (field → operator → value). Resource-agnostic — pass the `fields` a resource
 *  exposes. AND-combined; the parent turns `conditions` into the API `filters` param. */
export function FilterBar({
  fields,
  conditions,
  onChange,
}: {
  fields: FilterFieldDef[];
  conditions: FilterCondition[];
  onChange: (next: FilterCondition[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [fieldKey, setFieldKey] = useState(fields[0]?.key ?? "");
  const [attrKey, setAttrKey] = useState("");
  const [op, setOp] = useState<FilterOp>(OPS_BY_TYPE[fields[0]?.type ?? "text"][0]);
  const [value, setValue] = useState("");

  const field = fields.find((f) => f.key === fieldKey) ?? fields[0];
  const ops = field ? OPS_BY_TYPE[field.type] : [];
  const valueless = VALUELESS_OPS.has(op);
  const isAttr = field?.type === "attribute";

  function pickField(key: string) {
    setFieldKey(key);
    const f = fields.find((x) => x.key === key);
    if (f) setOp(OPS_BY_TYPE[f.type][0]); // reset operator to the field's first valid op
    setValue("");
  }

  function reset() {
    setFieldKey(fields[0]?.key ?? "");
    setAttrKey("");
    setOp(OPS_BY_TYPE[fields[0]?.type ?? "text"][0]);
    setValue("");
    setAdding(false);
  }

  function add() {
    if (!field) return;
    if (isAttr && !attrKey.trim()) return;
    if (!valueless && !value.trim()) return;
    const resolvedField = isAttr ? `attr:${attrKey.trim()}` : field.key;
    onChange([
      ...conditions,
      { id: newId(), field: resolvedField, op, value: valueless ? undefined : value.trim() },
    ]);
    reset();
  }

  function remove(id: string) {
    onChange(conditions.filter((c) => c.id !== id));
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {conditions.map((c) => (
          <span
            key={c.id}
            className="inline-flex items-center gap-1.5 rounded-full border bg-card py-1 pl-2.5 pr-1 text-xs"
          >
            <span className="whitespace-nowrap">{conditionLabel(c, fields)}</span>
            <button
              type="button"
              onClick={() => remove(c.id)}
              className="grid size-4 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Remove filter"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}

        {!adding && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1 border-dashed px-2 text-xs"
            onClick={() => setAdding(true)}
          >
            <Plus className="size-3.5" /> Add filter
          </Button>
        )}

        {conditions.length > 0 && !adding && (
          <button
            type="button"
            onClick={() => onChange([])}
            className="ml-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Clear all
          </button>
        )}
      </div>

      {adding && (
        <div className="flex flex-wrap items-end gap-2 rounded-lg border bg-muted/20 p-2.5">
          <label className="flex flex-col gap-1">
            <span className="text-micro uppercase tracking-wide text-muted-foreground">Field</span>
            <PopoverSelect
              value={fieldKey}
              align="start"
              options={fields.map((f) => ({ value: f.key, label: f.label }))}
              onChange={(v) => {
                if (v !== null) pickField(v);
              }}
              buttonClassName={cn(SELECT_TRIGGER, "min-w-[9rem]")}
            />
          </label>

          {isAttr && (
            <label className="flex flex-col gap-1">
              <span className="text-micro uppercase tracking-wide text-muted-foreground">Attribute</span>
              <Input
                value={attrKey}
                onChange={(e) => setAttrKey(e.target.value)}
                placeholder="plan"
                className="h-8 w-28 text-xs"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          )}

          <label className="flex flex-col gap-1">
            <span className="text-micro uppercase tracking-wide text-muted-foreground">Operator</span>
            <PopoverSelect
              value={op}
              align="start"
              options={ops.map((o) => ({ value: o, label: OP_LABEL[o] }))}
              onChange={(v) => {
                if (v !== null) setOp(v as FilterOp);
              }}
              buttonClassName={cn(SELECT_TRIGGER, "min-w-[8rem]")}
            />
          </label>

          {!valueless && (
            <label className="flex flex-col gap-1">
              <span className="text-micro uppercase tracking-wide text-muted-foreground">Value</span>
              <Input
                type={field?.type === "date" ? "date" : "text"}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    add();
                  }
                }}
                placeholder="Enterprise"
                className={cn("h-8 text-xs", field?.type === "date" ? "w-40" : "w-36")}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          )}

          <div className="flex items-center gap-1">
            <Button type="button" size="sm" className="h-8 px-3 text-xs" onClick={add}>
              Add
            </Button>
            <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={reset}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
