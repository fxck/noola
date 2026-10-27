import { useEffect, useMemo, useState } from "react";
import { BadgeCheck, Briefcase, Cpu, FolderKanban, Tag, TriangleAlert, Wallet } from "lucide-react";
import type { BuilderFieldDef } from "@/components/data-table/filter-builder";
import type { FilterOp } from "@/components/data-table/types";
import { ACCOUNT_STATUS_LABEL, fetchContactTags, type AccountStatus } from "@/lib/contacts";
import { fetchTechnologyUsage, compareVersionsDesc, type TechnologyVersionUsage } from "@/lib/technologies";

// Filter-builder fields over synced client accounts (account sync, 0121), shared by the contacts
// directory and the broadcast composer so a segment means the same thing in both. Technology
// fields are minted from what's actually in use (GET /technologies): `tech:<key>` with version
// ops, suggesting the versions in use. A `Role is …` condition in the same row scopes the account
// conditions to that membership (server-side), e.g. "Role is owner AND PostgreSQL version < 16".

const TECH_OPS: FilterOp[] = ["exists", "not_exists", "lt", "gt", "is", "is_not"];
const TECH_OP_LABEL: Partial<Record<FilterOp, string>> = {
  exists: "is used",
  not_exists: "is not used",
  lt: "version below",
  gt: "version above",
  is: "version is",
  is_not: "version is not",
};
const NUMBER_OPS: FilterOp[] = ["gt", "lt", "is", "is_not"];

export function useAccountFilterFields(): BuilderFieldDef[] {
  const [usage, setUsage] = useState<TechnologyVersionUsage[]>([]);
  useEffect(() => {
    fetchTechnologyUsage().then(setUsage).catch(() => setUsage([]));
  }, []);

  return useMemo<BuilderFieldDef[]>(() => {
    const techs = new Map<string, { name: string; versions: TechnologyVersionUsage[] }>();
    for (const u of usage) {
      const t = techs.get(u.technology) ?? { name: u.name, versions: [] };
      t.versions.push(u);
      techs.set(u.technology, t);
    }
    return [
      {
        key: "account_status",
        label: "Account",
        type: "text",
        ops: ["is", "is_not"],
        options: (Object.keys(ACCOUNT_STATUS_LABEL) as AccountStatus[]).map((v) => ({ value: v, label: ACCOUNT_STATUS_LABEL[v] })),
        icon: BadgeCheck,
      },
      { key: "company_role", label: "Role at client", type: "text", ops: ["is", "is_not", "exists", "not_exists"], icon: Briefcase },
      { key: "company.avg_monthly_spend", label: "Client spend / month", type: "text", ops: NUMBER_OPS, icon: Wallet },
      { key: "company.project_count", label: "Client projects", type: "text", ops: NUMBER_OPS, icon: FolderKanban },
      {
        key: "tech_eol",
        label: "EOL technology",
        type: "text",
        ops: ["exists", "not_exists"],
        opLabels: { exists: "is in use", not_exists: "is not in use" },
        icon: TriangleAlert,
      },
      ...[...techs.entries()]
        .sort(([, a], [, b]) => a.name.localeCompare(b.name))
        .map(([key, t]): BuilderFieldDef => ({
          key: `tech:${key}`,
          label: t.name,
          type: "text",
          ops: TECH_OPS,
          opLabels: TECH_OP_LABEL,
          icon: Cpu,
          options: t.versions
            .slice()
            .sort((a, b) => compareVersionsDesc(a.version, b.version))
            .filter((v) => v.version)
            .map((v) => ({ value: v.version, label: v.version, hint: `${v.contacts} people${v.status === "eol" ? " · EOL" : ""}` })),
        })),
    ];
  }, [usage]);
}

/** The contact Tag field (0123): exact tag (case-insensitive), contains, has any / none —
 *  suggesting the tags in use with their counts. */
export function useTagFilterField(): BuilderFieldDef {
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([]);
  useEffect(() => {
    fetchContactTags().then(setTags).catch(() => setTags([]));
  }, []);
  return useMemo<BuilderFieldDef>(
    () => ({
      key: "tag",
      label: "Tag",
      type: "text",
      ops: ["is", "is_not", "contains", "exists", "not_exists"],
      opLabels: { exists: "has any", not_exists: "has none" },
      icon: Tag,
      options: tags.map((t) => ({ value: t.tag, label: t.tag, hint: t.count })),
    }),
    [tags],
  );
}
