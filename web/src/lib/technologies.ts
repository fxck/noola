import { api } from "@/lib/api";

// Technology usage across synced client accounts (account sync, 0121): per technology version,
// how many services / projects / clients / reachable people run it, their project spend, and the
// catalog lifecycle status (supported / deprecated / eol; unknown = not in the catalog).

export type TechStatus = "supported" | "deprecated" | "eol" | "unknown";

export interface TechnologyVersionUsage {
  technology: string;
  name: string;
  category: string;
  version: string;
  status: TechStatus;
  services: number;
  projects: number;
  companies: number;
  contacts: number;
  project_spend: number;
}

export async function fetchTechnologyUsage(): Promise<TechnologyVersionUsage[]> {
  return (await api<{ usage: TechnologyVersionUsage[] }>("/technologies")).usage;
}

/** Order versions numerically where possible (8.10 after 8.9), newest first. */
export function compareVersionsDesc(a: string, b: string): number {
  return b.localeCompare(a, undefined, { numeric: true });
}

/** Where the tenant's catalog comes from: "zerops" = Noola imports the public zerops.yml + import.yml
 *  schemas daily (unlisted in-use versions read as EOL); "manual" = pushed via the API; null = none. */
export interface CatalogState {
  source: "manual" | "zerops" | null;
  synced_at: string | null;
  last_error: string | null;
  technologies: number;
}

export async function fetchCatalogState(): Promise<CatalogState> {
  return (await api<{ catalog: CatalogState }>("/technologies/catalog")).catalog;
}

export async function setCatalogSource(source: "zerops" | "manual"): Promise<CatalogState> {
  return (await api<{ catalog: CatalogState }>("/technologies/catalog", { method: "PUT", body: JSON.stringify({ source }) })).catalog;
}

export async function syncCatalog(): Promise<CatalogState> {
  return (await api<{ catalog: CatalogState }>("/technologies/catalog/sync", { method: "POST" })).catalog;
}
