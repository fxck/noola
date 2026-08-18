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
  /** Your own identifier for this account (Intercom company `company_id`), or null. The dedup key for
   *  identify (external_id first, then name). */
  external_id: string | null;
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
  /** External id (Intercom company_id). "" clears it; omitted leaves it unchanged. */
  external_id?: string;
  domain?: string;
  plan?: string;
  attributes?: Record<string, unknown>;
}

export interface CompanyFilter {
  field: string;
  op: string;
  value?: string;
}

export interface CompanyQuery {
  q?: string;
  band?: HealthBand;
  /** Filter-builder conditions (AND-combined); attribute fields use the `attr:<key>` prefix. */
  filters?: CompanyFilter[];
  /** OR-ed groups (conditions AND within a group, groups OR across). */
  filterGroups?: CompanyFilter[][];
  limit?: number;
  offset?: number;
  sort?: string;
  dir?: "asc" | "desc";
}

/** Resolve company names → ids (get-or-create), preserving order — the contact editor's
 *  "add a company that doesn't exist yet" primitive. De-duped by id server-side. */
export async function ensureCompanies(names: string[]): Promise<{ id: string; name: string }[]> {
  const clean = names.map((n) => n.trim()).filter(Boolean);
  if (!clean.length) return [];
  const res = await api<{ companies: { id: string; name: string }[] }>("/companies/ensure", {
    method: "POST",
    body: JSON.stringify({ names: clean }),
  });
  return res.companies;
}

/** One page of companies + the total match count (server-side pagination/sort/filter). */
export async function fetchCompanies(opts: CompanyQuery = {}): Promise<{ companies: Company[]; total: number }> {
  const p = new URLSearchParams();
  if (opts.q) p.set("q", opts.q);
  if (opts.band) p.set("band", opts.band);
  const packFilter = (f: CompanyFilter) => ({ field: f.field, op: f.op, ...(f.value !== undefined ? { value: f.value } : {}) });
  if (opts.filters && opts.filters.length) p.set("filters", JSON.stringify(opts.filters.map(packFilter)));
  const groups = (opts.filterGroups ?? []).filter((g) => g.length > 0);
  if (groups.length) p.set("filterGroups", JSON.stringify(groups.map((g) => g.map(packFilter))));
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
