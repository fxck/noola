import { withTenant } from "@repo/db";

// Companies (account records) — first-class accounts, one step up from a contact's free-text company.
// A company rolls up its contacts + their email-channel tickets into a health signal. Tickets link to
// a contact by the customer email on the email channel (tickets.channel_type='email' AND
// external_channel_id = contact.email), so a company's tickets = the tickets of its contacts' emails.

export interface Company {
  id: string;
  name: string;
  domain: string;
  plan: string;
  attributes: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export type HealthBand = "healthy" | "at_risk" | "critical";

export interface AccountHealth {
  score: number;        // 0..100
  band: HealthBand;
  openTickets: number;
  negativeOpen: number; // open tickets with negative sentiment — the strongest risk signal
  totalTickets: number;
  avgCsat: number | null;
  lastActivity: string | null;
}

export interface CompanyRow extends Company {
  contactCount: number;
  health: AccountHealth;
}

const COLS = "id, name, domain, plan, attributes, created_at, updated_at";

/**
 * Deterministic, explainable account health. Starts at 100 and deducts for the signals that predict
 * churn/dissatisfaction: unresolved negative-sentiment tickets (heaviest), open-ticket backlog, and
 * low CSAT. A company with no tickets sits at 100 (no signal = healthy by default).
 */
export function computeHealth(a: {
  openTickets: number;
  negativeOpen: number;
  totalTickets: number;
  avgCsat: number | null;
  lastActivity: string | null;
}): AccountHealth {
  let score = 100;
  score -= a.negativeOpen * 15;             // each unhappy open ticket is a strong negative
  score -= Math.min(a.openTickets * 3, 30); // a growing backlog, capped
  if (a.avgCsat != null) score -= (5 - a.avgCsat) * 8; // 5★ → 0, 1★ → −32
  score = Math.max(0, Math.min(100, Math.round(score)));
  const band: HealthBand = score >= 70 ? "healthy" : score >= 40 ? "at_risk" : "critical";
  return {
    score,
    band,
    openTickets: a.openTickets,
    negativeOpen: a.negativeOpen,
    totalTickets: a.totalTickets,
    avgCsat: a.avgCsat != null ? Math.round(a.avgCsat * 10) / 10 : null,
    lastActivity: a.lastActivity,
  };
}

// The rolled-up per-company ticket/CSAT aggregates, keyed by company_id, in one round-trip. Reused by
// the list (all companies) and the detail (one company, via the optional filter).
const ROLLUP_CTE = `
  WITH matched AS (
    SELECT c.company_id, t.id AS ticket_id, t.status, t.sentiment, t.updated_at
      FROM contacts c
      JOIN tickets t ON t.tenant_id = c.tenant_id AND t.contact_id = c.id
     WHERE c.company_id IS NOT NULL
  ),
  ticket_stats AS (
    SELECT company_id,
           count(*) FILTER (WHERE status = 'open')::int AS open_tickets,
           count(*) FILTER (WHERE status = 'open' AND sentiment = 'negative')::int AS neg_open,
           count(*)::int AS total_tickets,
           max(updated_at) AS last_activity
      FROM matched GROUP BY company_id
  ),
  csat_stats AS (
    SELECT m.company_id, avg(cr.rating)::float AS avg_csat
      FROM matched m JOIN csat_responses cr ON cr.ticket_id = m.ticket_id
     GROUP BY m.company_id
  )`;

function rowToHealth(r: Record<string, unknown>): AccountHealth {
  return computeHealth({
    openTickets: Number(r.open_tickets ?? 0),
    negativeOpen: Number(r.neg_open ?? 0),
    totalTickets: Number(r.total_tickets ?? 0),
    avgCsat: r.avg_csat != null ? Number(r.avg_csat) : null,
    lastActivity: r.last_activity ? (r.last_activity instanceof Date ? (r.last_activity as Date).toISOString() : String(r.last_activity)) : null,
  });
}

const mapCompany = (r: Record<string, unknown>): Company => ({
  id: r.id as string,
  name: r.name as string,
  domain: (r.domain as string) ?? "",
  plan: (r.plan as string) ?? "",
  attributes: (r.attributes as Record<string, unknown>) ?? {},
  created_at: r.created_at instanceof Date ? (r.created_at as Date).toISOString() : String(r.created_at),
  updated_at: r.updated_at instanceof Date ? (r.updated_at as Date).toISOString() : String(r.updated_at),
});

/** A filter-builder condition — the same {field, op, value} shape the contacts directory uses.
 *  Fields: name / domain / plan (columns) or attr:<key> (the attributes bag). */
export interface CompanyFilterCondition {
  field: string;
  op: string;
  value?: string;
}

export interface CompanyListOpts {
  q?: string;
  band?: HealthBand;
  conditions?: CompanyFilterCondition[];
  conditionGroups?: CompanyFilterCondition[][];
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortDir?: "asc" | "desc";
}

// A SQL health score that mirrors computeHealth() exactly, so server sort + band filter agree with
// the badge the client renders from the same rollups. Kept in one place next to computeHealth.
const HEALTH_SCORE_SQL = `GREATEST(0, LEAST(100, round((100
  - coalesce(ts.neg_open,0)*15
  - LEAST(coalesce(ts.open_tickets,0)*3, 30)
  - CASE WHEN cs.avg_csat IS NOT NULL THEN (5 - cs.avg_csat)*8 ELSE 0 END)::numeric)))::int`;

// Whitelist of sortable columns → safe SQL identifiers (field names can't be parameterized).
const COMPANY_SORT_SQL: Record<string, string> = {
  name: "name",
  health: "health_score",
  contacts: "contact_count",
  created: "created_at",
  lastActivity: "last_activity",
};

function bandClause(band?: HealthBand): string | null {
  if (band === "healthy") return "health_score >= 70";
  if (band === "at_risk") return "health_score >= 40 AND health_score < 70";
  if (band === "critical") return "health_score < 40";
  return null;
}

// Compile ONE filter-builder condition into SQL against the base CTE. name/domain/plan are columns;
// attr:<key> targets the attributes bag. Same op vocabulary + LIKE-escaping as the contacts grammar.
function compileCompanyCondition(cond: CompanyFilterCondition, clauses: string[], params: unknown[]): void {
  const { field, op } = cond;
  const value = cond.value;
  const needsValue = ["is", "is_not", "contains", "not_contains", "starts_with", "ends_with"].includes(op);
  if (needsValue && (value === undefined || value === "")) return;
  const likeLiteral = (v: string): string => v.replace(/[\\%_]/g, "\\$&");

  const isAttr = field.startsWith("attr:");
  let colExpr: string;
  if (field === "name") colExpr = "name";
  else if (field === "domain") colExpr = "domain";
  else if (field === "plan") colExpr = "plan";
  else if (isAttr) {
    const key = field.slice(5).trim();
    if (!key) return;
    params.push(key);
    colExpr = `attributes ->> $${params.length}`;
  } else return; // unknown field — ignore rather than error

  if (op === "exists") {
    clauses.push(isAttr ? `attributes ? $${params.length}` : `(${colExpr} IS NOT NULL AND ${colExpr} <> '')`);
    return;
  }
  if (op === "not_exists") {
    clauses.push(isAttr ? `NOT (attributes ? $${params.length})` : `(${colExpr} IS NULL OR ${colExpr} = '')`);
    return;
  }
  if (op === "is") {
    params.push(value);
    clauses.push(`${colExpr} = $${params.length}`);
  } else if (op === "is_not") {
    params.push(value);
    clauses.push(`${colExpr} IS DISTINCT FROM $${params.length}`);
  } else if (op === "contains") {
    params.push(`%${likeLiteral(String(value))}%`);
    clauses.push(`${colExpr} ILIKE $${params.length}`);
  } else if (op === "not_contains") {
    params.push(`%${likeLiteral(String(value))}%`);
    clauses.push(`(${colExpr} IS NULL OR ${colExpr} NOT ILIKE $${params.length})`);
  } else if (op === "starts_with") {
    params.push(`${likeLiteral(String(value))}%`);
    clauses.push(`${colExpr} ILIKE $${params.length}`);
  } else if (op === "ends_with") {
    params.push(`%${likeLiteral(String(value))}`);
    clauses.push(`${colExpr} ILIKE $${params.length}`);
  }
}

// The combined outer WHERE: health band + filter-builder conditions (AND) + OR groups. Appends its
// params to the shared array (which already carries the base CTE's q param, if any).
function companyWhere(opts: CompanyListOpts, params: unknown[]): string {
  const clauses: string[] = [];
  const band = bandClause(opts.band);
  if (band) clauses.push(band);
  for (const cond of opts.conditions ?? []) compileCompanyCondition(cond, clauses, params);
  const groupSqls: string[] = [];
  for (const group of opts.conditionGroups ?? []) {
    const gc: string[] = [];
    for (const cond of group) compileCompanyCondition(cond, gc, params);
    if (gc.length) groupSqls.push(`(${gc.join(" AND ")})`);
  }
  if (groupSqls.length) clauses.push(`(${groupSqls.join(" OR ")})`);
  return clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
}

// Shared base: rollups + health_score + optional name/domain search. When q is present it binds $1.
function companyBaseCte(q?: string): { cte: string; params: unknown[] } {
  const params: unknown[] = [];
  let qFilter = "";
  if (q && q.trim()) {
    params.push(`%${q.trim()}%`);
    qFilter = "WHERE co.name ILIKE $1 OR co.domain ILIKE $1";
  }
  const cte = `${ROLLUP_CTE}
    , base AS (
      SELECT co.${COLS.split(", ").join(", co.")},
             (SELECT count(*)::int FROM contacts x WHERE x.company_id = co.id) AS contact_count,
             ts.open_tickets, ts.neg_open, ts.total_tickets, ts.last_activity, cs.avg_csat,
             ${HEALTH_SCORE_SQL} AS health_score
        FROM companies co
        LEFT JOIN ticket_stats ts ON ts.company_id = co.id
        LEFT JOIN csat_stats cs ON cs.company_id = co.id
        ${qFilter}
    )`;
  return { cte, params };
}

/** One page of companies (contact counts + computed health), server-sorted + filtered + paginated. */
export async function listCompanies(tenantId: string, opts: CompanyListOpts = {}): Promise<CompanyRow[]> {
  return withTenant(tenantId, async (c) => {
    const { cte, params } = companyBaseCte(opts.q);
    const where = companyWhere(opts, params); // appends filter params after q
    const sortCol = COMPANY_SORT_SQL[opts.sortBy ?? ""] ?? "name";
    const dir = opts.sortDir === "desc" ? "DESC" : "ASC";
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    params.push(limit, offset);
    const r = await c.query(
      `${cte}
       SELECT * FROM base
       ${where}
       ORDER BY ${sortCol} ${dir} NULLS LAST, name ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return (r.rows as Record<string, unknown>[]).map((row) => ({
      ...mapCompany(row),
      contactCount: Number(row.contact_count ?? 0),
      health: rowToHealth(row),
    }));
  });
}

/** Total companies matching the same q/band filters — the pagination denominator. */
export async function countCompanies(tenantId: string, opts: CompanyListOpts = {}): Promise<number> {
  return withTenant(tenantId, async (c) => {
    const { cte, params } = companyBaseCte(opts.q);
    const where = companyWhere(opts, params);
    const r = await c.query(`${cte} SELECT count(*)::int AS n FROM base ${where}`, params);
    return Number(r.rows[0]?.n ?? 0);
  });
}

export interface CompanyDetail extends CompanyRow {
  contacts: { id: string; name: string; email: string | null }[];
}

/** One company: its record, health, and its contacts. Null if not in this tenant. */
export async function getCompany(tenantId: string, id: string): Promise<CompanyDetail | null> {
  return withTenant(tenantId, async (c) => {
    const cr = await c.query(
      `${ROLLUP_CTE}
       SELECT co.${COLS.split(", ").join(", co.")},
              (SELECT count(*)::int FROM contacts x WHERE x.company_id = co.id) AS contact_count,
              ts.open_tickets, ts.neg_open, ts.total_tickets, ts.last_activity, cs.avg_csat
         FROM companies co
         LEFT JOIN ticket_stats ts ON ts.company_id = co.id
         LEFT JOIN csat_stats cs ON cs.company_id = co.id
        WHERE co.id = $1`,
      [id],
    );
    if (!cr.rowCount) return null;
    const row = cr.rows[0] as Record<string, unknown>;
    const contactsR = await c.query(
      "SELECT id, name, email FROM contacts WHERE company_id = $1 ORDER BY name LIMIT 200",
      [id],
    );
    return {
      ...mapCompany(row),
      contactCount: Number(row.contact_count ?? 0),
      health: rowToHealth(row),
      contacts: contactsR.rows.map((x) => ({ id: x.id as string, name: x.name as string, email: (x.email as string) ?? null })),
    };
  });
}

export async function createCompany(tenantId: string, input: { name: string; domain?: string; plan?: string; attributes?: Record<string, unknown> }): Promise<Company> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO companies (tenant_id, name, domain, plan, attributes)
       VALUES (current_tenant(), $1, $2, $3, $4::jsonb) RETURNING ${COLS}`,
      [input.name, input.domain ?? "", input.plan ?? "", JSON.stringify(input.attributes ?? {})],
    );
    return mapCompany(r.rows[0] as Record<string, unknown>);
  });
}

export async function updateCompany(tenantId: string, id: string, patch: { name?: string; domain?: string; plan?: string; attributes?: Record<string, unknown> }): Promise<Company | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `UPDATE companies SET
          name = COALESCE($2, name),
          domain = COALESCE($3, domain),
          plan = COALESCE($4, plan),
          attributes = COALESCE($5::jsonb, attributes),
          updated_at = now()
        WHERE id = $1 RETURNING ${COLS}`,
      [id, patch.name ?? null, patch.domain ?? null, patch.plan ?? null, patch.attributes ? JSON.stringify(patch.attributes) : null],
    );
    if (!r.rowCount) return null;
    // Keep contacts' denormalized `company` text in sync on rename, so name-based segments /
    // broadcasts / directory filters don't drift off the account (the id-vs-name split).
    if (patch.name && patch.name.trim()) {
      await c.query(
        "UPDATE contacts SET company = $2, updated_at = now() WHERE company_id = $1 AND company IS DISTINCT FROM $2",
        [id, patch.name.trim()],
      );
    }
    return mapCompany(r.rows[0] as Record<string, unknown>);
  });
}

export async function deleteCompany(tenantId: string, id: string): Promise<boolean> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query("DELETE FROM companies WHERE id = $1", [id]);
    return (r.rowCount ?? 0) > 0;
  });
}

export interface CompanyImportRow {
  name: string;
  domain?: string;
  plan?: string;
  attributes?: Record<string, unknown>;
  /** Intercom "Company created at" — backfills the real created_at. */
  created_at?: string;
}

/**
 * Bulk import companies (CSV). Idempotent per row, keyed on lower(name) via the companies_name_uq
 * index (migration 0055) — a re-import updates in place, never duplicates. Provided scalar fields
 * overwrite (unless blank, which keeps the stored value) and attributes shallow-merge. One
 * tenant-scoped transaction. Returns how many rows were inserted vs updated.
 */
export async function bulkUpsertCompanies(
  tenantId: string,
  rows: CompanyImportRow[],
): Promise<{ created: number; updated: number }> {
  return withTenant(tenantId, async (c) => {
    let created = 0;
    let updated = 0;
    for (const r of rows) {
      const name = (r.name ?? "").trim();
      if (!name) continue;
      const res = await c.query(
        `INSERT INTO companies (tenant_id, name, domain, plan, attributes, created_at)
         VALUES (current_tenant(), $1, COALESCE($2,''), COALESCE($3,''), COALESCE($4::jsonb,'{}'::jsonb), COALESCE($5::timestamptz, now()))
         ON CONFLICT (tenant_id, lower(name)) DO UPDATE SET
           domain = CASE WHEN COALESCE($2,'') = '' THEN companies.domain ELSE EXCLUDED.domain END,
           plan = CASE WHEN COALESCE($3,'') = '' THEN companies.plan ELSE EXCLUDED.plan END,
           attributes = companies.attributes || COALESCE($4::jsonb,'{}'::jsonb),
           created_at = COALESCE($5::timestamptz, companies.created_at),
           updated_at = now()
         RETURNING (xmax = 0) AS created`,
        [name, r.domain ?? null, r.plan ?? null, r.attributes ? JSON.stringify(r.attributes) : null, r.created_at ?? null],
      );
      if (res.rows[0].created) created++;
      else updated++;
    }
    return { created, updated };
  });
}

/**
 * Resolve a set of company names → their ids, creating any that don't exist yet (keyed on
 * lower(name)). The linking primitive behind the contacts importer: a person's free-text company
 * becomes a real company_id FK. Returns a lower(name) → id map.
 */
export async function ensureCompaniesByName(
  tenantId: string,
  names: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const uniq = [...new Set(names.map((n) => (n ?? "").trim()).filter(Boolean))];
  if (!uniq.length) return map;
  return withTenant(tenantId, async (c) => {
    for (const name of uniq) {
      // DO UPDATE (no-op) instead of DO NOTHING so RETURNING yields the row on conflict too.
      const r = await c.query(
        `INSERT INTO companies (tenant_id, name) VALUES (current_tenant(), $1)
         ON CONFLICT (tenant_id, lower(name)) DO UPDATE SET name = companies.name
         RETURNING id`,
        [name],
      );
      map.set(name.toLowerCase(), r.rows[0].id as string);
    }
    return map;
  });
}
