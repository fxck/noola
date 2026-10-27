import { relayPool, withTenant } from "@repo/db";
import type { PublicTechnologyCatalogInput } from "@repo/contracts";
import { parseServiceType } from "./service-type.js";
import { applyTechnologyCatalog } from "./public-accounts.js";

// The Zerops technology catalog, imported by Noola itself (technology_catalog.source = 'zerops').
// Runtimes come from the zerops.yml JSON schema (build/run `base`), managed services — databases,
// caches, queues, search, storage — from the import.yml JSON schema (service `type`). Every
// concrete version the schemas offer is 'supported'; an in-use version they no longer offer reads
// as EOL (see tech-status.ts — computed at read time, so a freshly synced old service is EOL at
// once, not after the next import). Refreshed daily by the server's scheduler, or on demand.

export const ZEROPS_SCHEMA_URLS = [
  "https://api.app-prg1.zerops.io/api/rest/public/settings/zerops-yml-json-schema.json",
  "https://api.app-prg1.zerops.io/api/rest/public/settings/import-project-yml-json-schema.json",
];

// Spelling variants the schemas carry for one technology.
const ALIASES: Record<string, string[]> = {
  go: ["golang"],
  "object-storage": ["objectstorage"],
  "shared-storage": ["sharedstorage"],
};

const CATEGORY: Record<string, string> = {
  alpine: "os", ubuntu: "os",
  static: "web server", nginx: "web server",
  postgresql: "database", mariadb: "database", clickhouse: "database",
  valkey: "cache",
  nats: "messaging", kafka: "messaging",
  typesense: "search", meilisearch: "search", elasticsearch: "search",
  qdrant: "vector database",
  "object-storage": "storage", "shared-storage": "storage", "local-storage": "storage", seaweedfs: "storage",
  zcp: "platform",
};

const NAMES: Record<string, string> = {
  nodejs: "Node.js", php: "PHP", "php-nginx": "PHP + Nginx", "php-apache": "PHP + Apache", python: "Python",
  go: "Go", bun: "Bun", deno: "Deno", rust: "Rust", java: "Java", dotnet: ".NET", elixir: "Elixir",
  gleam: "Gleam", ruby: "Ruby", docker: "Docker", static: "Static", nginx: "Nginx", alpine: "Alpine",
  ubuntu: "Ubuntu", postgresql: "PostgreSQL", mariadb: "MariaDB", clickhouse: "ClickHouse", valkey: "Valkey",
  nats: "NATS", kafka: "Kafka", typesense: "Typesense", meilisearch: "Meilisearch",
  elasticsearch: "Elasticsearch", qdrant: "Qdrant", "object-storage": "Object Storage",
  "shared-storage": "Shared Storage", "local-storage": "Local Storage", seaweedfs: "SeaweedFS", zcp: "ZCP", zero: "Zero",
};

const ROLLING = new Set(["latest", "canary", "nightly", "stable"]);

/** Every enum string in a JSON schema that looks like a service type / base. */
function collectTypes(schema: unknown, out: Set<string>): void {
  if (Array.isArray(schema)) {
    for (const v of schema) collectTypes(v, out);
  } else if (schema && typeof schema === "object") {
    for (const [k, v] of Object.entries(schema)) {
      if (k === "enum" && Array.isArray(v) && v.some((x) => typeof x === "string" && x.includes("@"))) {
        for (const x of v) if (typeof x === "string") out.add(x);
      } else {
        collectTypes(v, out);
      }
    }
  }
}

/** Fetch both public schemas and return every service type / base they allow. */
export async function fetchZeropsServiceTypes(): Promise<string[]> {
  const types = new Set<string>();
  for (const url of ZEROPS_SCHEMA_URLS) {
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    collectTypes(await r.json(), types);
  }
  if (!types.size) throw new Error("Zerops schemas listed no service types");
  return [...types];
}

/** Build the catalog from service types (pure — the tested half). */
export function buildZeropsCatalog(types: Iterable<string>): PublicTechnologyCatalogInput {
  const aliasToKey = new Map<string, string>();
  for (const [k, list] of Object.entries(ALIASES)) for (const a of list) aliasToKey.set(a, k);
  const catalog = new Map<string, Set<string>>();
  for (const t of types) {
    const p = parseServiceType(t, aliasToKey);
    if (!catalog.has(p.technology)) catalog.set(p.technology, new Set());
    if (p.version && !ROLLING.has(p.version)) catalog.get(p.technology)!.add(p.version);
  }
  return {
    technologies: [...catalog.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, versions]) => ({
      key,
      name: NAMES[key] ?? key,
      category: CATEGORY[key] ?? "runtime",
      aliases: ALIASES[key] ?? [],
      versions: [...versions]
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .map((version) => ({ version, status: "supported" as const })),
    })),
  };
}

export interface CatalogState {
  source: "manual" | "zerops" | null;
  synced_at: string | null;
  last_error: string | null;
  technologies: number;
}

export async function getCatalogState(tenantId: string): Promise<CatalogState> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(`SELECT source, synced_at, last_error, technologies FROM technology_catalog`);
    const row = r.rows[0];
    if (!row) return { source: null, synced_at: null, last_error: null, technologies: 0 };
    return {
      source: row.source,
      synced_at: row.synced_at ? (row.synced_at as Date).toISOString() : null,
      last_error: row.last_error ?? null,
      technologies: Number(row.technologies ?? 0),
    };
  });
}

/** Import the Zerops catalog into one tenant now (and make 'zerops' its catalog source). A fetch
 *  failure is recorded on the tenant (last_error) and rethrown; the previous catalog stays. */
export async function syncZeropsCatalog(tenantId: string, types?: string[]): Promise<CatalogState> {
  try {
    const catalog = buildZeropsCatalog(types ?? (await fetchZeropsServiceTypes()));
    await applyTechnologyCatalog(tenantId, catalog, "zerops");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await withTenant(tenantId, (c) =>
      c.query(
        `INSERT INTO technology_catalog (tenant_id, source, last_error) VALUES (current_tenant(), 'zerops', $1)
         ON CONFLICT (tenant_id) DO UPDATE SET source = 'zerops', last_error = $1, updated_at = now()`,
        [msg.slice(0, 500)],
      ),
    );
    throw e;
  }
  return getCatalogState(tenantId);
}

/** Stop importing from Zerops (the current catalog stays, statuses as imported; unlisted versions
 *  then read as unknown rather than EOL). */
export async function disableZeropsCatalog(tenantId: string): Promise<CatalogState> {
  await withTenant(tenantId, (c) => c.query(`UPDATE technology_catalog SET source = 'manual', updated_at = now()`));
  return getCatalogState(tenantId);
}

type Log = { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
let running = false;

/** Daily refresh for every tenant on the Zerops catalog (server.ts runs this hourly; a tenant is due
 *  23h after its last successful import, so replicas and restarts don't multiply the work). The
 *  schemas are fetched once per run; one tenant's failure never starves the rest. */
export async function runZeropsCatalogScheduler(log?: Log): Promise<void> {
  if (running) return;
  running = true;
  try {
    let due;
    try {
      due = await relayPool.query(
        `SELECT tenant_id FROM technology_catalog
          WHERE source = 'zerops' AND (synced_at IS NULL OR synced_at < now() - interval '23 hours')`,
      );
    } catch (e) {
      log?.warn({ err: (e as Error)?.message }, "zerops catalog: due-tenant scan failed");
      return;
    }
    if (!due.rowCount) return;
    let types: string[];
    try {
      types = await fetchZeropsServiceTypes();
    } catch (e) {
      log?.warn({ err: (e as Error)?.message }, "zerops catalog: schema fetch failed");
      return;
    }
    for (const row of due.rows as { tenant_id: string }[]) {
      try {
        const s = await syncZeropsCatalog(row.tenant_id, types);
        log?.info({ tenantId: row.tenant_id, technologies: s.technologies }, "zerops catalog: imported");
      } catch (e) {
        log?.warn({ tenantId: row.tenant_id, err: (e as Error)?.message }, "zerops catalog: import failed");
      }
    }
  } finally {
    running = false;
  }
}
