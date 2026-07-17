import { useMemo, type ComponentType } from "react";
import type { Column } from "@tanstack/react-table";
import { MultiSelect, type ComboOption } from "@/components/ui/combobox";

/**
 * A faceted filter for one column — the openstatus DataTableFacetedFilter pattern on our
 * MultiSelect. Values + live counts come from react-table's getFacetedUniqueValues(); the
 * selection is the column's filter value (a string[]). `staticOptions` fixes the label/icon
 * set (counts still come from the facets); omit it to derive options from the data.
 */
export function FacetedFilter<T>({
  column,
  label,
  icon,
  staticOptions,
}: {
  column: Column<T, unknown> | undefined;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  staticOptions?: ComboOption[];
}) {
  const facets = column?.getFacetedUniqueValues();

  const options = useMemo<ComboOption[]>(() => {
    if (staticOptions) {
      return staticOptions.map((o) => ({ ...o, hint: facets?.get(o.value) ?? 0 }));
    }
    const opts: ComboOption[] = [];
    facets?.forEach((count, value) => {
      if (value == null || value === "") return;
      opts.push({ value: String(value), label: String(value), hint: count });
    });
    return opts.sort((a, b) => Number(b.hint) - Number(a.hint) || a.label.localeCompare(b.label));
  }, [facets, staticOptions]);

  if (!column) return null;
  const values = (column.getFilterValue() as string[] | undefined) ?? [];

  return (
    <MultiSelect
      label={label}
      icon={icon}
      values={values}
      options={options}
      searchable={options.length > 8}
      onChange={(v) => column.setFilterValue(v.length ? v : undefined)}
    />
  );
}
