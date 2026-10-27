import { withTenant } from "@repo/db";
import type { PoolClient } from "pg";
import { PublicCompanyInput, type PublicTechnologyCatalogInput } from "@repo/contracts";
import { repinPrimary, removeSyncMemberships } from "./public-contacts.js";
import { companyAccountStatusSql, type AccountStatus } from "./companies.js";
import { parseServiceType } from "./service-type.js";
import { versionStatusSql } from "./tech-status.js";

export { parseServiceType } from "./service-type.js";

// The public accounts surface (accounts:read / accounts:write): companies = the external system's
// clients, synced as SNAPSHOTS keyed by external_id (never by name — two real clients may share a
// name, and a lead's free-text company must never be mistaken for a client). A snapshot carries the
// spend and, when present, the FULL member list and FULL project list (each project with its full
// service list), which replace what the previous sync wrote. Manual (agent-made) memberships are
// never touched. Services resolve to a technology through the tenant's catalog (technologies).

async function loadAliases(c: PoolClient): Promise<Map<string, string>> {
  const r = await c.query(`SELECT key, aliases FROM technologies`);
  const map = new Map<string, string>();
  for (const row of r.rows as { key: string; aliases: string[] }[]) {
    for (const a of row.aliases) map.set(a, row.key);
  }
  return map;
}

// ── Company snapshots ─────────────────────────────────────────────────────────────

export interface PublicCompany {
  id: string;
  external_id: string;
  name: string;
  avg_monthly_spend: number | null;
  currency: string | null;
  account_status: AccountStatus;
  synced_at: string | null;
  sync_removed_at: string | null;
  members: { external_id: string | null; email: string | null; name: string; role: string; source: string }[];
  projects: {
    external_id: string;
    name: string;
    status: string;
    avg_monthly_spend: number | null;
    services: { type: string; hostname: string; technology: string; version: string; os: string; mode: string }[];
  }[];
}

export interface CompanySyncResult {
  company: PublicCompany;
  created: boolean;
  /** Member external_ids that matched no contact — sync those people (contacts/upsert) first. */
  unknown_members: string[];
}

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
const num = (v: unknown): number | null => (v == null ? null : Number(v));

async function readCompany(c: PoolClient, id: string): Promise<PublicCompany> {
  const co = (await c.query(
    `SELECT id, external_id, name, avg_monthly_spend, currency, synced_at, sync_removed_at,
            ${companyAccountStatusSql("companies")} AS account_status
       FROM companies WHERE id = $1`,
    [id],
  )).rows[0];
  const members = await c.query(
    `SELECT ct.external_id, ct.email, ct.name, cc.role, cc.source
       FROM contact_companies cc JOIN contacts ct ON ct.tenant_id = cc.tenant_id AND ct.id = cc.contact_id
      WHERE cc.company_id = $1 ORDER BY ct.name, ct.external_id`,
    [id],
  );
  const projects = await c.query(
    `SELECT p.external_id, p.name, p.status, p.avg_monthly_spend,
            COALESCE((SELECT json_agg(json_build_object('type', s.raw_type, 'hostname', s.hostname,
                        'technology', s.technology, 'version', s.version, 'os', s.os, 'mode', s.mode)
                        ORDER BY s.hostname, s.raw_type)
                        FROM project_services s WHERE s.project_id = p.id), '[]'::json) AS services
       FROM company_projects p WHERE p.company_id = $1 ORDER BY p.name, p.external_id`,
    [id],
  );
  return {
    id: co.id,
    external_id: co.external_id,
    name: co.name,
    avg_monthly_spend: num(co.avg_monthly_spend),
    currency: co.currency ?? null,
    account_status: co.account_status,
    synced_at: iso(co.synced_at),
    sync_removed_at: iso(co.sync_removed_at),
    members: members.rows.map((m) => ({ external_id: m.external_id, email: m.email, name: m.name, role: m.role, source: m.source })),
    projects: projects.rows.map((p) => ({
      external_id: p.external_id, name: p.name, status: p.status, avg_monthly_spend: num(p.avg_monthly_spend), services: p.services,
    })),
  };
}

/** Apply one company snapshot on the caller's transaction. */
async function syncCompany(c: PoolClient, input: PublicCompanyInput, aliases: Map<string, string>): Promise<CompanySyncResult> {
  const found = await c.query(`SELECT id FROM companies WHERE external_id = $1 LIMIT 1`, [input.external_id]);
  let id: string;
  const created = !found.rowCount;
  if (created) {
    const ins = await c.query(
      `INSERT INTO companies (tenant_id, name, external_id, avg_monthly_spend, currency, synced_at)
       VALUES (current_tenant(), $1, $2, $3, $4, now()) RETURNING id`,
      [input.name ?? input.external_id, input.external_id, input.avg_monthly_spend ?? null, input.currency ?? null],
    );
    id = ins.rows[0].id as string;
  } else {
    id = found.rows[0].id as string;
    await c.query(
      `UPDATE companies SET
         name = COALESCE($2, name),
         avg_monthly_spend = CASE WHEN $3::boolean THEN $4::numeric ELSE avg_monthly_spend END,
         currency = COALESCE($5, currency),
         synced_at = now(), sync_removed_at = NULL, updated_at = now()
       WHERE id = $1`,
      [id, input.name ?? null, input.avg_monthly_spend !== undefined, input.avg_monthly_spend ?? null, input.currency ?? null],
    );
    // Keep members' denormalized primary-company label in step with a rename.
    if (input.name) {
      await c.query(`UPDATE contacts SET company = $2 WHERE company_id = $1 AND company IS DISTINCT FROM $2`, [id, input.name]);
    }
  }

  let unknown: string[] = [];
  if (input.members) {
    const byExt = new Map<string, string>(); // external_id → role (last one wins)
    for (const m of input.members) byExt.set(m.external_id, m.role ?? "");
    const ids = [...byExt.keys()];
    const found = ids.length
      ? ((await c.query(`SELECT id, external_id FROM contacts WHERE external_id = ANY($1::text[])`, [ids])).rows as { id: string; external_id: string }[])
      : [];
    const foundIds = new Set(found.map((r) => r.external_id));
    unknown = ids.filter((x) => !foundIds.has(x));

    const touched = new Set<string>();
    for (const r of found) {
      await c.query(
        `INSERT INTO contact_companies (tenant_id, contact_id, company_id, is_primary, role, source)
         VALUES (current_tenant(), $1, $2, false, $3, 'sync')
         ON CONFLICT (tenant_id, contact_id, company_id) DO UPDATE SET role = EXCLUDED.role, source = 'sync'`,
        [r.id, id, byExt.get(r.external_id)],
      );
      touched.add(r.id);
    }
    const gone = await c.query(
      `SELECT contact_id FROM contact_companies
        WHERE company_id = $1 AND source = 'sync' AND NOT (contact_id = ANY($2::uuid[]))`,
      [id, [...touched]],
    );
    for (const g of gone.rows as { contact_id: string }[]) await removeSyncMemberships(c, g.contact_id, [id]);
    for (const contactId of touched) await repinPrimary(c, contactId);
  }

  if (input.projects) {
    const keep: string[] = [];
    for (const p of input.projects) {
      const pr = await c.query(
        `INSERT INTO company_projects (tenant_id, company_id, external_id, name, status, avg_monthly_spend)
         VALUES (current_tenant(), $1, $2, COALESCE($3, ''), COALESCE($4, ''), $5)
         ON CONFLICT (tenant_id, external_id) DO UPDATE SET
           company_id = EXCLUDED.company_id,
           name = COALESCE($3, company_projects.name),
           status = COALESCE($4, company_projects.status),
           avg_monthly_spend = CASE WHEN $6::boolean THEN EXCLUDED.avg_monthly_spend ELSE company_projects.avg_monthly_spend END,
           updated_at = now()
         RETURNING id`,
        [id, p.external_id, p.name ?? null, p.status ?? null, p.avg_monthly_spend ?? null, p.avg_monthly_spend !== undefined],
      );
      const projectId = pr.rows[0].id as string;
      keep.push(projectId);
      await c.query(`DELETE FROM project_services WHERE project_id = $1`, [projectId]);
      for (const svc of p.services) {
        const t = parseServiceType(svc.type, aliases);
        await c.query(
          `INSERT INTO project_services (tenant_id, project_id, external_id, hostname, raw_type, technology, version, os, mode)
           VALUES (current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8)`,
          [projectId, svc.external_id || null, svc.hostname ?? "", svc.type, t.technology, t.version, t.os, t.mode],
        );
      }
    }
    await c.query(`DELETE FROM company_projects WHERE company_id = $1 AND NOT (id = ANY($2::uuid[]))`, [id, keep]);
  }

  return { company: await readCompany(c, id), created, unknown_members: unknown };
}

/** Single snapshot (POST /v1/public/companies/upsert). */
export async function publicSyncCompany(tenantId: string, input: PublicCompanyInput): Promise<CompanySyncResult> {
  return withTenant(tenantId, async (c) => syncCompany(c, input, await loadAliases(c)));
}

export interface CompanyBulkRow {
  index: number;
  external_id: string | null;
  status: "created" | "updated" | "invalid" | "error";
  company_id?: string;
  unknown_members?: string[];
  error?: unknown;
}

/** Bulk snapshots (POST /v1/public/companies/bulk): one transaction, a SAVEPOINT per row — an
 *  invalid row is reported and skipped; every other row commits. */
export async function publicSyncCompaniesBulk(tenantId: string, rows: unknown[]) {
  const results = await withTenant(tenantId, async (c) => {
    const aliases = await loadAliases(c);
    const out: CompanyBulkRow[] = [];
    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i] as { external_id?: unknown } | null;
      const rawId = raw && typeof raw.external_id === "string" ? raw.external_id : null;
      const parsed = PublicCompanyInput.safeParse(rows[i]);
      if (!parsed.success) {
        out.push({ index: i, external_id: rawId, status: "invalid", error: parsed.error.flatten() });
        continue;
      }
      await c.query("SAVEPOINT row");
      try {
        const r = await syncCompany(c, parsed.data, aliases);
        await c.query("RELEASE SAVEPOINT row");
        out.push({
          index: i, external_id: parsed.data.external_id, status: r.created ? "created" : "updated",
          company_id: r.company.id, unknown_members: r.unknown_members,
        });
      } catch (e) {
        await c.query("ROLLBACK TO SAVEPOINT row");
        if ((e as { code?: string }).code !== "23505") throw e;
        out.push({ index: i, external_id: parsed.data.external_id, status: "error", error: "concurrent write — retry" });
      }
    }
    return out;
  });
  const count = (s: CompanyBulkRow["status"]) => results.filter((r) => r.status === s).length;
  return { created: count("created"), updated: count("updated"), invalid: count("invalid"), errors: count("error"), results };
}

export async function publicGetCompany(tenantId: string, externalId: string): Promise<PublicCompany | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(`SELECT id FROM companies WHERE external_id = $1 LIMIT 1`, [externalId]);
    return r.rowCount ? readCompany(c, r.rows[0].id as string) : null;
  });
}

/** The client was deleted in the system of record (POST /v1/public/companies/remove). Soft: the
 *  company and its memberships stay (history, conversations) and it reads as 'former'; its projects
 *  go — they no longer run anywhere, so they must stop counting in technology audiences. */
export async function publicRemoveCompany(tenantId: string, externalId: string): Promise<PublicCompany | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `UPDATE companies SET sync_removed_at = COALESCE(sync_removed_at, now()), updated_at = now()
        WHERE external_id = $1 RETURNING id`,
      [externalId],
    );
    if (!r.rowCount) return null;
    const id = r.rows[0].id as string;
    await c.query(`DELETE FROM company_projects WHERE company_id = $1`, [id]);
    return readCompany(c, id);
  });
}

// ── Technology catalog + overview ─────────────────────────────────────────────────

/** Replace the catalog wholesale (PUT /v1/public/technologies — a manual catalog, which also turns
 *  off the Zerops import). */
export async function publicPutTechnologies(tenantId: string, input: PublicTechnologyCatalogInput) {
  return applyTechnologyCatalog(tenantId, input, "manual");
}

/** Write a whole catalog and record its source (technology_catalog, 0122), then re-resolve every
 *  stored service's technology through the new aliases (a service synced before its alias existed).
 *  Shared by the manual push and the Zerops import (zerops-catalog.ts). */
export async function applyTechnologyCatalog(
  tenantId: string,
  input: PublicTechnologyCatalogInput,
  source: "manual" | "zerops",
) {
  return withTenant(tenantId, async (c) => {
    await c.query(
      `INSERT INTO technology_catalog (tenant_id, source, synced_at, last_error, technologies)
       VALUES (current_tenant(), $1, now(), NULL, $2)
       ON CONFLICT (tenant_id) DO UPDATE SET source = $1, synced_at = now(), last_error = NULL,
         technologies = $2, updated_at = now()`,
      [source, input.technologies.length],
    );
    const keys = input.technologies.map((t) => t.key);
    await c.query(`DELETE FROM technologies WHERE NOT (key = ANY($1::text[]))`, [keys]);
    for (const t of input.technologies) {
      await c.query(
        `INSERT INTO technologies (tenant_id, key, name, category, aliases)
         VALUES (current_tenant(), $1, $2, $3, $4::text[])
         ON CONFLICT (tenant_id, key) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category,
           aliases = EXCLUDED.aliases, updated_at = now()`,
        [t.key, t.name ?? t.key, t.category ?? "", t.aliases.filter((a) => a !== t.key)],
      );
      const versions = t.versions.map((v) => v.version);
      await c.query(`DELETE FROM technology_versions WHERE technology = $1 AND NOT (version = ANY($2::text[]))`, [t.key, versions]);
      for (const v of t.versions) {
        await c.query(
          `INSERT INTO technology_versions (tenant_id, technology, version, status) VALUES (current_tenant(), $1, $2, $3)
           ON CONFLICT (tenant_id, technology, version) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`,
          [t.key, v.version, v.status],
        );
      }
    }
    const re = await c.query(
      `UPDATE project_services s SET technology = t.key
         FROM technologies t WHERE s.technology = ANY(t.aliases) AND s.technology <> t.key`,
    );
    return { technologies: input.technologies.length, services_reresolved: re.rowCount ?? 0 };
  });
}

export interface TechnologyVersionUsage {
  technology: string;
  name: string;
  category: string;
  version: string;
  /** Catalog lifecycle (tech-status.ts): with the Zerops catalog an unlisted version is 'eol'; with
   *  a manual one it's 'unknown'. */
  status: "supported" | "deprecated" | "eol" | "unknown";
  services: number;
  projects: number;
  companies: number;
  /** Distinct synced contacts belonging to those companies (the reachable audience). */
  contacts: number;
  /** Sum of those projects' avg_monthly_spend. */
  project_spend: number;
}

/** Usage per technology version across live synced companies (removed companies' projects are
 *  already gone). The data behind the Technologies overview. */
export async function technologyOverview(tenantId: string): Promise<TechnologyVersionUsage[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `WITH used AS (
         SELECT s.technology, s.version, s.id AS service_id, p.id AS project_id, p.company_id, p.avg_monthly_spend
           FROM project_services s JOIN company_projects p ON p.tenant_id = s.tenant_id AND p.id = s.project_id
       ),
       per_project AS (SELECT DISTINCT technology, version, project_id, avg_monthly_spend FROM used),
       g AS (
         SELECT u.technology, u.version,
                count(DISTINCT u.service_id)::int AS services,
                count(DISTINCT u.project_id)::int AS projects,
                count(DISTINCT u.company_id)::int AS companies
           FROM used u GROUP BY u.technology, u.version
       )
       SELECT g.technology, g.version, g.services, g.projects, g.companies,
              COALESCE(t.name, g.technology) AS name, COALESCE(t.category, '') AS category,
              ${versionStatusSql("g")} AS status,
              (SELECT count(DISTINCT cc.contact_id)::int FROM contact_companies cc
                WHERE cc.source = 'sync' AND cc.company_id IN (SELECT company_id FROM used x WHERE x.technology = g.technology AND x.version = g.version)) AS contacts,
              COALESCE((SELECT sum(pp.avg_monthly_spend) FROM per_project pp WHERE pp.technology = g.technology AND pp.version = g.version), 0)::float AS project_spend
         FROM g LEFT JOIN technologies t ON t.key = g.technology
        ORDER BY g.technology, g.version`,
    );
    return r.rows as TechnologyVersionUsage[];
  });
}
