import { api } from "@/lib/api";

// Companies (account records) client. A company rolls up its contacts + email-channel tickets into a
// health signal, computed server-side.

export type HealthBand = "healthy" | "at_risk" | "critical";

export interface AccountHealth {
  score: number;
  band: HealthBand;
  openTickets: number;
  negativeOpen: number;
  totalTickets: number;
  avgCsat: number | null;
  lastActivity: string | null;
}

export interface Company {
  id: string;
  name: string;
  domain: string;
  plan: string;
  attributes: Record<string, unknown>;
  contactCount: number;
  health: AccountHealth;
  created_at: string;
  updated_at: string;
}

export interface CompanyDetail extends Company {
  contacts: { id: string; name: string; email: string | null }[];
}

export interface CompanyInput {
  name?: string;
  domain?: string;
  plan?: string;
  attributes?: Record<string, unknown>;
}

export interface CompanyQuery {
  q?: string;
  band?: HealthBand;
  limit?: number;
  offset?: number;
  sort?: string;
  dir?: "asc" | "desc";
}

/** One page of companies + the total match count (server-side pagination/sort/filter). */
export async function fetchCompanies(opts: CompanyQuery = {}): Promise<{ companies: Company[]; total: number }> {
  const p = new URLSearchParams();
  if (opts.q) p.set("q", opts.q);
  if (opts.band) p.set("band", opts.band);
  if (opts.limit != null) p.set("limit", String(opts.limit));
  if (opts.offset != null) p.set("offset", String(opts.offset));
  if (opts.sort) p.set("sort", opts.sort);
  if (opts.dir) p.set("dir", opts.dir);
  const qs = p.toString() ? `?${p}` : "";
  return api<{ companies: Company[]; total: number }>(`/companies${qs}`);
}
export async function fetchCompany(id: string): Promise<CompanyDetail> {
  return (await api<{ company: CompanyDetail }>(`/companies/${id}`)).company;
}
export async function createCompany(input: CompanyInput): Promise<Company> {
  return (await api<{ company: Company }>("/companies", { method: "POST", body: JSON.stringify(input) })).company;
}
export async function updateCompany(id: string, patch: CompanyInput): Promise<Company> {
  return (await api<{ company: Company }>(`/companies/${id}`, { method: "PATCH", body: JSON.stringify(patch) })).company;
}
export async function deleteCompany(id: string): Promise<void> {
  await api(`/companies/${id}`, { method: "DELETE" });
}

/** CSV import (Intercom migration): the api maps name/domain/plan + free-form attribute columns
 *  onto the idempotent upsert, keyed on lower(name). Returns per-outcome counts. */
export async function importCompaniesCsv(
  csv: string,
): Promise<{ created: number; updated: number; skipped: number }> {
  return api<{ created: number; updated: number; skipped: number }>("/companies/import", {
    method: "POST",
    body: JSON.stringify({ csv }),
  });
}

export const HEALTH_META: Record<HealthBand, { label: string; badge: "default" | "warning" | "muted"; dot: string }> = {
  healthy: { label: "Healthy", badge: "default", dot: "var(--success)" },
  at_risk: { label: "At risk", badge: "warning", dot: "var(--warning)" },
  critical: { label: "Critical", badge: "warning", dot: "var(--destructive)" },
};
