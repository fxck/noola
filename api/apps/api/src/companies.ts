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

/** All companies with contact counts + computed health, worst-health first (surface risk). */
export async function listCompanies(tenantId: string, q?: string): Promise<CompanyRow[]> {
  return withTenant(tenantId, async (c) => {
    const params: unknown[] = [];
    let filter = "";
    if (q && q.trim()) { params.push(`%${q.trim()}%`); filter = `WHERE co.name ILIKE $${params.length} OR co.domain ILIKE $${params.length}`; }
    const r = await c.query(
      `${ROLLUP_CTE}
       SELECT co.${COLS.split(", ").join(", co.")},
              (SELECT count(*)::int FROM contacts x WHERE x.company_id = co.id) AS contact_count,
              ts.open_tickets, ts.neg_open, ts.total_tickets, ts.last_activity, cs.avg_csat
         FROM companies co
         LEFT JOIN ticket_stats ts ON ts.company_id = co.id
         LEFT JOIN csat_stats cs ON cs.company_id = co.id
         ${filter}
        ORDER BY co.name
        LIMIT 5000`,
      params,
    );
    return (r.rows as Record<string, unknown>[])
      .map((row) => ({ ...mapCompany(row), contactCount: Number(row.contact_count ?? 0), health: rowToHealth(row) }))
      .sort((a, b) => a.health.score - b.health.score);
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
    return r.rowCount ? mapCompany(r.rows[0] as Record<string, unknown>) : null;
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
        `INSERT INTO companies (tenant_id, name, domain, plan, attributes)
         VALUES (current_tenant(), $1, COALESCE($2,''), COALESCE($3,''), COALESCE($4::jsonb,'{}'::jsonb))
         ON CONFLICT (tenant_id, lower(name)) DO UPDATE SET
           domain = CASE WHEN COALESCE($2,'') = '' THEN companies.domain ELSE EXCLUDED.domain END,
           plan = CASE WHEN COALESCE($3,'') = '' THEN companies.plan ELSE EXCLUDED.plan END,
           attributes = companies.attributes || COALESCE($4::jsonb,'{}'::jsonb),
           updated_at = now()
         RETURNING (xmax = 0) AS created`,
        [name, r.domain ?? null, r.plan ?? null, r.attributes ? JSON.stringify(r.attributes) : null],
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
