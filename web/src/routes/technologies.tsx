import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Cpu, Mail, Users, TriangleAlert, Search, RefreshCw } from "lucide-react";
import { CustomersViewSwitch } from "@/components/customers/view-switch";
import { StatePill, type PillTone } from "@/components/data-table/cells";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toaster";
import { relativeTime } from "@/lib/tickets";
import { formatSpend } from "@/lib/companies";
import {
  fetchTechnologyUsage, compareVersionsDesc, fetchCatalogState, setCatalogSource, syncCatalog,
  type TechnologyVersionUsage, type TechStatus, type CatalogState,
} from "@/lib/technologies";

// Technologies — which technology versions synced client accounts run (account sync, 0121): per
// version the projects, clients and reachable people, their project spend, and the catalog
// lifecycle status. Every version drills to its people (Customers, pre-filtered) or straight into
// a broadcast composer with that audience — the "email everyone still on PostgreSQL 13" path.

const STATUS_META: Record<TechStatus, { label: string; tone: PillTone }> = {
  supported: { label: "Supported", tone: "neutral" },
  deprecated: { label: "Deprecated", tone: "warning" },
  eol: { label: "EOL", tone: "danger" },
  unknown: { label: "Not in catalog", tone: "draft" },
};

/** The audience for one version: customers whose client runs it. */
function versionConditions(u: TechnologyVersionUsage) {
  return [
    { field: "account_status", op: "is", value: "customer" },
    u.version
      ? { field: `tech:${u.technology}`, op: "is", value: u.version }
      : { field: `tech:${u.technology}`, op: "exists" },
  ];
}

const EOL_CONDITIONS = [
  { field: "account_status", op: "is", value: "customer" },
  { field: "tech_eol", op: "exists" },
];

export function TechnologiesPage() {
  const [usage, setUsage] = useState<TechnologyVersionUsage[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [q, setQ] = useState("");

  const [catalog, setCatalog] = useState<CatalogState | null>(null);
  const [syncing, setSyncing] = useState(false);

  const load = () => {
    setFailed(false);
    fetchTechnologyUsage().then(setUsage).catch(() => setFailed(true));
    fetchCatalogState().then(setCatalog).catch(() => setCatalog(null));
  };
  useEffect(load, []);

  // Turn on / re-run the Zerops import. Statuses are computed at read time, so a reload of the usage
  // right after reflects the new catalog.
  async function importZerops(first: boolean) {
    setSyncing(true);
    try {
      const next = first ? await setCatalogSource("zerops") : await syncCatalog();
      setCatalog(next);
      toast.success(`Imported ${next.technologies} technologies from the Zerops schemas.`);
      setUsage(await fetchTechnologyUsage());
    } catch {
      toast.error("Couldn't import the Zerops catalog.");
      fetchCatalogState().then(setCatalog).catch(() => {});
    } finally {
      setSyncing(false);
    }
  }

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const byTech = new Map<string, { key: string; name: string; category: string; versions: TechnologyVersionUsage[] }>();
    for (const u of usage ?? []) {
      if (needle && !u.name.toLowerCase().includes(needle) && !u.technology.includes(needle) && !u.category.toLowerCase().includes(needle)) continue;
      const g = byTech.get(u.technology) ?? { key: u.technology, name: u.name, category: u.category, versions: [] };
      g.versions.push(u);
      byTech.set(u.technology, g);
    }
    return [...byTech.values()]
      .map((g) => ({ ...g, versions: g.versions.sort((a, b) => compareVersionsDesc(a.version, b.version)) }))
      .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  }, [usage, q]);

  const eolRows = (usage ?? []).filter((u) => u.status === "eol");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 px-4">
        <h1 className="text-sm font-semibold tracking-tight">Technologies</h1>
        <CustomersViewSwitch current="technologies" />
        <div className="relative ml-auto w-56">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter technologies…" className="h-8 pl-8 text-xs" />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-4 pb-10">
          {/* fixed-height slot so the table doesn't jump when the catalog state arrives */}
          <div className="mb-3 min-h-8">
            {catalog && <CatalogBar catalog={catalog} syncing={syncing} onImport={(first) => void importZerops(first)} />}
          </div>
          {failed ? (
            <ErrorState title="Couldn't load technologies" onRetry={load} />
          ) : usage === null ? (
            <RowsSkeleton rows={8} />
          ) : usage.length === 0 ? (
            <EmptyState
              icon={Cpu}
              title="No technologies yet"
              description="Technologies appear once client projects are synced through the accounts API."
            />
          ) : (
            <>
              {eolRows.length > 0 && (
                <div className="mb-4 flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-small">
                  <TriangleAlert className="size-4 shrink-0 text-destructive" />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{eolRows.length} end-of-life {eolRows.length === 1 ? "version" : "versions"}</span>{" "}
                    <span className="text-muted-foreground">still in use by your clients.</span>
                  </span>
                  <DrillLinks conditions={EOL_CONDITIONS} />
                </div>
              )}

              <div className="overflow-hidden rounded-lg border">
                <table className="w-full text-small">
                  <thead className="bg-muted/40 text-micro uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Technology</th>
                      <th className="px-3 py-2 text-left font-medium">Version</th>
                      <th className="px-3 py-2 text-left font-medium">Status</th>
                      <th className="px-3 py-2 text-right font-medium">Projects</th>
                      <th className="px-3 py-2 text-right font-medium">Clients</th>
                      <th className="px-3 py-2 text-right font-medium">People</th>
                      <th className="px-3 py-2 text-right font-medium">Spend / mo</th>
                      <th className="w-px px-3 py-2" />
                    </tr>
                  </thead>
                  {groups.map((g) => (
                    <tbody key={g.key} className="border-t">
                      {g.versions.map((u, i) => (
                        <tr key={u.version || "-"} className="group hover:bg-muted/30">
                          <td className="px-3 py-2 align-top">
                            {i === 0 && (
                              <div className="min-w-0">
                                <div className="font-medium">{g.name}</div>
                                {g.category && <div className="text-micro text-muted-foreground">{g.category}</div>}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2 font-mono text-xs">{u.version || "—"}</td>
                          <td className="px-3 py-2">
                            {u.status !== "supported" && (
                              <StatePill label={STATUS_META[u.status].label} tone={STATUS_META[u.status].tone} dot={u.status === "eol"} className="normal-case" />
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">{u.projects}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{u.companies}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{u.contacts}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{u.project_spend ? formatSpend(u.project_spend, null) : "—"}</td>
                          <td className={cn("px-3 py-2", "opacity-60 group-hover:opacity-100 group-focus-within:opacity-100")}>
                            <DrillLinks conditions={versionConditions(u)} compact />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  ))}
                </table>
              </div>
              <p className="mt-2 text-micro text-muted-foreground">
                People = synced members of those clients. Spend sums the projects' average monthly spend.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Where the version statuses come from, and the one control that matters: import the Zerops catalog
// (zerops.yml bases + import.yml service types, refreshed daily) — after which anything clients run
// that Zerops no longer offers reads as EOL.
function CatalogBar({ catalog, syncing, onImport }: { catalog: CatalogState; syncing: boolean; onImport: (first: boolean) => void }) {
  const zerops = catalog.source === "zerops";
  return (
    <div className="flex items-center gap-3 text-small text-muted-foreground">
      <span className="min-w-0 flex-1">
        {zerops ? (
          <>
            Catalog: <span className="text-foreground">Zerops schemas</span> (zerops.yml + import.yml) · {catalog.technologies} technologies
            {catalog.synced_at && <> · imported {relativeTime(catalog.synced_at)}</>}
            {catalog.last_error && <span className="text-destructive"> · last import failed</span>}
            {" · "}versions Zerops no longer offers show as EOL
          </>
        ) : (
          <>Import the Zerops catalog to mark versions Zerops no longer offers as EOL.</>
        )}
      </span>
      <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" disabled={syncing} onClick={() => onImport(!zerops)}>
        <RefreshCw className={cn("size-3.5", syncing && "animate-spin")} />
        {zerops ? "Re-import" : "Use Zerops catalog"}
      </Button>
    </div>
  );
}

// The two drills for an audience: its people (Customers, pre-filtered) and a new broadcast.
function DrillLinks({ conditions, compact }: { conditions: { field: string; op: string; value?: string }[]; compact?: boolean }) {
  const json = JSON.stringify(conditions);
  const cls =
    "inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <Link to="/contacts" search={{ filters: json }} className={cls} title="Show these people">
        <Users className="size-3.5" />
        {!compact && "People"}
      </Link>
      <Link to="/broadcasts" search={{ audience: json }} className={cls} title="Email these people">
        <Mail className="size-3.5" />
        {!compact && "Email"}
      </Link>
    </div>
  );
}
