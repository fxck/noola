import pg from "pg";
import { appPool, relayPool } from "@repo/db";
import { createContact, getContact, listContacts, updateContact, upsertContact } from "../src/contacts.js";
import { getCompany, listCompanies, bulkUpsertCompanies, ensureCompaniesByName } from "../src/companies.js";
import { publicUpsertContact, publicRemoveContact, publicSetTopic } from "../src/public-contacts.js";
import {
  parseServiceType, publicSyncCompany, publicSyncCompaniesBulk, publicGetCompany, publicRemoveCompany,
  publicPutTechnologies, technologyOverview,
} from "../src/public-accounts.js";
import { createTopic, deleteTopic } from "../src/subscription-topics.js";
import { previewSegment } from "../src/broadcasts.js";
import { syncZeropsCatalog, disableZeropsCatalog, buildZeropsCatalog, getCatalogState } from "../src/zerops-catalog.js";

// Account sync seam (0121): service-type parsing; company snapshots keyed by external_id only
// (same-name clients coexist; id-less name dedup still works for CSV/identify); sync-owned
// memberships replaced per snapshot without touching manual links, with primary re-pinning;
// projects/services replace + move; customer/user/former/lead status; membership-aware company
// filter and rollups; technology catalog aliases + usage overview; topic opt-outs. Postgres only.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

async function main() {
  const superPool = new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432), database: process.env.DB_NAME,
    user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 1,
  });
  const clean = async () => {
    await superPool.query("DELETE FROM contacts WHERE external_id LIKE 'pa-%' OR email LIKE 'pa-%'");
    await superPool.query("DELETE FROM companies WHERE external_id LIKE 'pa-%' OR name LIKE 'PA Co%'");
    await superPool.query("DELETE FROM technologies WHERE tenant_id = $1", [A]);
    await superPool.query("DELETE FROM technology_catalog WHERE tenant_id = $1", [A]);
    await superPool.query("DELETE FROM subscription_topics WHERE name LIKE 'PA topic%'");
  };
  await clean();

  // ---- parser ----
  {
    const p = (t: string) => { const x = parseServiceType(t); return `${x.technology}|${x.version}|${x.os}|${x.mode}`; };
    check("parse ubuntu/php-nginx@8.4+1.22", p("ubuntu/php-nginx@8.4+1.22") === "php-nginx|8.4|ubuntu|");
    check("parse postgresql:ha@16", p("postgresql:ha@16") === "postgresql|16||ha");
    check("parse alpine@3.24 (OS-only base)", p("alpine@3.24") === "alpine|3.24||");
    check("parse object-storage", p("object-storage") === "object-storage|||");
    check("parse alpine/static", p("alpine/static") === "static||alpine|");
    check("parse alias golang → go", parseServiceType("alpine/golang@1.22", new Map([["golang", "go"]])).technology === "go");
  }

  // ---- people first ----
  for (const [id, email] of [["pa-u1", "pa-u1@x.example"], ["pa-u2", "pa-u2@x.example"], ["pa-u3", "pa-u3@x.example"]]) {
    await publicUpsertContact(A, { external_id: id, email, name: id });
  }
  const lead = await createContact(A, { email: "pa-lead@x.example", name: "Conference Lead" });

  // ---- company snapshot: members + projects ----
  const s1 = await publicSyncCompany(A, {
    external_id: "pa-c1", name: "PA Co Same", avg_monthly_spend: 120.5, currency: "EUR",
    members: [{ external_id: "pa-u1", role: "owner" }, { external_id: "pa-u2", role: "admin" }, { external_id: "pa-ghost" }],
    projects: [
      { external_id: "pa-p1", name: "Shop", avg_monthly_spend: 80, services: [
        { type: "ubuntu/nodejs@22", hostname: "api" }, { type: "postgresql:ha@14", hostname: "db" }, { type: "alpine/golang@1.22", hostname: "worker" },
      ] },
      { external_id: "pa-p2", name: "Blog", avg_monthly_spend: 40, services: [{ type: "php-nginx@8.1+1.22", hostname: "app" }] },
    ],
  });
  check("snapshot created", s1.created && s1.company.name === "PA Co Same" && s1.company.avg_monthly_spend === 120.5);
  check("unknown member reported", s1.unknown_members.length === 1 && s1.unknown_members[0] === "pa-ghost");
  check("members synced with roles", s1.company.members.length === 2 && s1.company.members.some((m) => m.external_id === "pa-u1" && m.role === "owner" && m.source === "sync"));
  check("projects + services stored", s1.company.projects.length === 2 && s1.company.projects.find((p) => p.external_id === "pa-p1")?.services.length === 3);

  // ---- same-name clients coexist; id-less name dedup intact ----
  {
    const s2 = await publicSyncCompany(A, { external_id: "pa-c2", name: "PA Co Same", members: [{ external_id: "pa-u1", role: "admin" }] });
    check("second client with the same name is a separate company", s2.created && s2.company.id !== s1.company.id);
    const m1 = await ensureCompaniesByName(A, ["PA Co Idless"]);
    const m2 = await ensureCompaniesByName(A, ["pa co idless"]);
    check("id-less companies still dedup by name", m1.get("pa co idless") === m2.get("pa co idless"));
    const csv = await bulkUpsertCompanies(A, [{ name: "PA Co Idless", plan: "pro" }, { name: "PA Co Same" }]);
    check("CSV row matching only synced names creates an id-less company (never adopts a client)", csv.updated === 1 && csv.created === 1);
  }

  // ---- identify path (widget): company external id adopts an id-less same-name company ----
  {
    const ids = await ensureCompaniesByName(A, ["PA Co Adopt"]);
    const { contact } = await upsertContact(A, { email: "pa-w@x.example", company: "PA Co Adopt", company_external_id: "pa-wc" });
    check("identify adopts the id-less company and stamps its id", contact.company_id === ids.get("pa co adopt"));
    const again = await upsertContact(A, { email: "pa-w2@x.example", company: "Renamed", company_external_id: "pa-wc" });
    check("identify by company id reuses it", again.contact.company_id === ids.get("pa co adopt"));
  }

  // ---- account status ----
  {
    const u1 = (await listContacts(A, { q: "pa-u1@" })).contacts[0];
    check("synced member of a live synced company → customer", u1?.account_status === "customer");
    check("u1 belongs to both same-named clients", (u1?.companies ?? []).length === 2);
    const u3 = (await listContacts(A, { q: "pa-u3@" })).contacts[0];
    check("synced person without company → user", u3?.account_status === "user");
    check("never-synced contact → lead", (await getContact(A, lead.id))?.account_status === "lead");
    const customers = await listContacts(A, { q: "pa-", conditions: [{ field: "account_status", op: "is", value: "customer" }] });
    check("filter account_status = customer", customers.contacts.length === 2 && customers.contacts.every((c) => c.account_status === "customer"));
  }

  // ---- manual link to a synced company doesn't make a lead a customer; members sync leaves it ----
  {
    await updateContact(A, lead.id, { company_ids: [s1.company.id] });
    check("manually linked lead stays a lead", (await getContact(A, lead.id))?.account_status === "lead");
    const s = await publicSyncCompany(A, { external_id: "pa-c1", members: [{ external_id: "pa-u1", role: "owner" }] });
    check("members sync drops the removed sync member, keeps the manual link",
      s.company.members.length === 2 && !s.company.members.some((m) => m.external_id === "pa-u2") && s.company.members.some((m) => m.source === "manual"));
    const u2 = (await listContacts(A, { q: "pa-u2@" })).contacts[0];
    check("dropped member: no companies, primary cleared, status user",
      (u2?.companies ?? []).length === 0 && u2?.company_id === null && u2?.account_status === "user");
    check("members omitted → unchanged", (await publicSyncCompany(A, { external_id: "pa-c1", avg_monthly_spend: 130 })).company.members.length === 2);
  }

  // ---- membership-aware company filter + company detail/rollup ----
  {
    // u1's primary is pa-c1 (first); make sure a filter on a NON-primary company still reaches them.
    await superPool.query("UPDATE companies SET name = 'PA Co Second' WHERE external_id = 'pa-c2'");
    const byCompany = await listContacts(A, { company: "PA Co Second" });
    check("company filter matches a non-primary membership", byCompany.contacts.some((c) => c.external_id === "pa-u1"));
    const cond = await listContacts(A, { q: "pa-", conditions: [{ field: "company", op: "contains", value: "second" }] });
    check("company condition (contains) over memberships", cond.contacts.length === 1 && cond.contacts[0].external_id === "pa-u1");
    const c2 = (await publicGetCompany(A, "pa-c2"))!;
    const detail = await getCompany(A, c2.id);
    check("company detail lists members via junction (non-primary too)", detail?.contacts.some((c) => c.email === "pa-u1@x.example") === true && detail?.contactCount === 1);
    const list = await listCompanies(A, { q: "PA Co Second", conditions: [{ field: "account_status", op: "is", value: "customer" }] });
    check("company list filter account_status", list.length === 1 && list[0].account_status === "customer");
  }

  // ---- projects: replace, move between companies ----
  {
    const s = await publicSyncCompany(A, { external_id: "pa-c2", projects: [{ external_id: "pa-p2", name: "Blog (moved)", services: [{ type: "php-nginx@8.3" }] }] });
    check("project moved to another company", s.company.projects.length === 1 && s.company.projects[0].services[0].version === "8.3");
    const c1 = (await publicGetCompany(A, "pa-c1"))!;
    check("…and left the original", c1.projects.length === 1 && c1.projects[0].external_id === "pa-p1");
  }

  // ---- technology catalog: aliases re-resolve, overview ----
  {
    const r = await publicPutTechnologies(A, { technologies: [
      { key: "go", name: "Go", category: "runtime", aliases: ["golang"], versions: [{ version: "1.22", status: "supported" }] },
      { key: "postgresql", name: "PostgreSQL", category: "database", aliases: [], versions: [
        { version: "14", status: "eol" }, { version: "16", status: "supported" }] },
    ] });
    check("catalog re-resolves stored alias services", r.services_reresolved >= 1);
    const usage = await technologyOverview(A);
    const pg14 = usage.find((u) => u.technology === "postgresql" && u.version === "14");
    check("overview: postgresql 14 eol, 1 project, 1 company, 1 synced contact, spend 80",
      pg14?.status === "eol" && pg14.projects === 1 && pg14.companies === 1 && pg14.contacts === 1 && pg14.project_spend === 80);
    check("overview: golang counted as go", usage.some((u) => u.technology === "go" && u.version === "1.22") && !usage.some((u) => u.technology === "golang"));
    check("overview: uncatalogued version → unknown", usage.find((u) => u.technology === "nodejs")?.status === "unknown");
  }

  // ---- account filters (tech / version / eol / role / spend / project count) ----
  {
    // State: u1 = owner of pa-c1 (nodejs 22, postgresql:ha 14 [eol], go 1.22; spend 130, 1 project)
    //        and admin of pa-c2 (php-nginx 8.3; no spend).
    const who = async (...conditions: { field: string; op: string; value?: string }[]) =>
      (await listContacts(A, { q: "pa-", conditions: conditions as never })).contacts.map((c) => c.external_id).sort().join(",");
    check("tech exists", (await who({ field: "tech:postgresql", op: "exists" })) === "pa-u1");
    check("tech not_exists excludes users", !(await who({ field: "tech:postgresql", op: "not_exists" })).includes("pa-u1"));
    check("tech version lt 16", (await who({ field: "tech:postgresql", op: "lt", value: "16" })) === "pa-u1");
    check("tech version gt 14 → none", (await who({ field: "tech:postgresql", op: "gt", value: "14" })) === "");
    check("tech version is 14", (await who({ field: "tech:postgresql", op: "is", value: "14" })) === "pa-u1");
    check("tech version is major matches minor (go is 1 → 1.22)", (await who({ field: "tech:go", op: "is", value: "1" })) === "pa-u1");
    check("tech version compare minor (php-nginx lt 8.4)", (await who({ field: "tech:php-nginx", op: "lt", value: "8.4" })) === "pa-u1");
    check("uses an EOL version", (await who({ field: "tech_eol", op: "exists" })) === "pa-u1");
    check("role + tech on the SAME membership: owner of a php client → none",
      (await who({ field: "company_role", op: "is", value: "Owner" }, { field: "tech:php-nginx", op: "exists" })) === "");
    check("role + tech on the same membership: admin of a php client → u1",
      (await who({ field: "company_role", op: "is", value: "admin" }, { field: "tech:php-nginx", op: "exists" })) === "pa-u1");
    check("client spend gt 100", (await who({ field: "company.avg_monthly_spend", op: "gt", value: "100" })) === "pa-u1");
    check("client spend lt 100 → none", (await who({ field: "company.avg_monthly_spend", op: "lt", value: "100" })) === "");
    check("project count is 1", (await who({ field: "company.project_count", op: "is", value: "1" })) === "pa-u1");
    const grouped = await listContacts(A, { q: "pa-", conditionGroups: [
      [{ field: "company_role", op: "is", value: "owner" }, { field: "tech:php-nginx", op: "exists" }],
      [{ field: "tech:postgresql", op: "lt", value: "16" }],
    ] as never });
    check("OR groups keep role folding per group", grouped.contacts.map((c) => c.external_id).join(",") === "pa-u1");
    const preview = await previewSegment(A, { q: "pa-", conditions: [{ field: "tech:postgresql", op: "lt", value: "16" }] });
    check("broadcast preview compiles the tech filter", preview.total === 1 && preview.reachable.email === 1);
  }

  // ---- Zerops catalog import: unlisted in-use versions are EOL ----
  {
    const types = [
      "postgresql:ha@16", "postgresql@17", "ubuntu/nodejs@22", "ubuntu/nodejs@latest", "go@1", "go@1.22", "alpine/golang@1.22",
      "php-nginx@8.4+1.22", "object-storage", "objectstorage",
    ];
    const cat = buildZeropsCatalog(types);
    check("zerops catalog folds aliases", cat.technologies.some((t) => t.key === "go") && !cat.technologies.some((t) => t.key === "golang" || t.key === "objectstorage"));
    check("zerops catalog drops rolling tags", !cat.technologies.find((t) => t.key === "nodejs")?.versions.some((v) => v.version === "latest"));
    const state = await syncZeropsCatalog(A, types);
    check("catalog source = zerops, synced", state.source === "zerops" && !!state.synced_at && state.technologies === cat.technologies.length);
    const status = async (tech: string, version: string) =>
      (await technologyOverview(A)).find((u) => u.technology === tech && u.version === version)?.status;
    check("unlisted in-use version → eol (postgresql 14)", (await status("postgresql", "14")) === "eol");
    check("unlisted in-use version → eol (php-nginx 8.3)", (await status("php-nginx", "8.3")) === "eol");
    check("listed version → supported (nodejs 22)", (await status("nodejs", "22")) === "supported");
    await publicSyncCompany(A, { external_id: "pa-c1", projects: [{ external_id: "pa-p1", name: "Shop", avg_monthly_spend: 80, services: [
      { type: "postgresql@16.4" }, { type: "go@1.21" }, { type: "ubuntu/nodejs@latest" }, { type: "object-storage" }, { type: "postgresql:ha@14" },
    ] }] });
    check("patch version covered by its leaf (16.4 → 16)", (await status("postgresql", "16.4")) === "supported");
    check("family alias doesn't vouch for an unlisted minor (go 1.21)", (await status("go", "1.21")) === "eol");
    check("rolling tag → supported", (await status("nodejs", "latest")) === "supported");
    check("versionless catalogued service → supported", (await status("object-storage", "")) === "supported");
    const eolUsers = (await listContacts(A, { q: "pa-", conditions: [{ field: "tech_eol", op: "exists" }] })).contacts.map((c) => c.external_id);
    check("tech_eol filter follows the zerops rule", eolUsers.includes("pa-u1"));
    const off = await disableZeropsCatalog(A);
    check("switch to manual: unlisted → unknown", off.source === "manual" && (await status("postgresql", "14")) === "unknown");
    check("catalog state readable", (await getCatalogState(A)).source === "manual");
  }

  // ---- bulk: per-row results ----
  {
    const res = await publicSyncCompaniesBulk(A, [
      { external_id: "pa-c3", name: "PA Co Three", avg_monthly_spend: 10 },
      { name: "no id" },
      { external_id: "pa-c1", avg_monthly_spend: 150 },
    ]);
    check("bulk companies counts", res.created === 1 && res.updated === 1 && res.invalid === 1);
  }

  // ---- removal: company → former, projects gone; person → former ----
  {
    const rc = await publicRemoveCompany(A, "pa-c2");
    check("removed company → former, projects deleted", rc?.account_status === "former" && rc.projects.length === 0);
    const u1 = (await listContacts(A, { q: "pa-u1@" })).contacts[0];
    check("member still customer via the other live company", u1?.account_status === "customer");
    const revived = await publicSyncCompany(A, { external_id: "pa-c2" });
    check("a later sync revives a removed company", revived.company.account_status === "customer");
    const rp = await publicRemoveContact(A, "pa-u1");
    check("removed person → former, sync memberships dropped", rp?.account_status === "former");
    const again = await publicUpsertContact(A, { external_id: "pa-u1" });
    check("re-upsert revives the person (user)", again.status === "updated" && again.contact.account_status === "user");
  }

  // ---- topic opt-out ----
  {
    const t = await createTopic(A, { name: "PA topic EOL" });
    const off = await publicSetTopic(A, "pa-u3", t.id, false);
    check("topic opt-out", off.status === "ok" && off.topics.find((x) => x.id === t.id)?.subscribed === false);
    const on = await publicSetTopic(A, "pa-u3", t.id, true);
    check("topic opt-in", on.status === "ok" && on.topics.find((x) => x.id === t.id)?.subscribed === true);
    check("topic: unknown contact", (await publicSetTopic(A, "pa-nobody", t.id, false)).status === "not_found");
    await deleteTopic(A, t.id);
  }

  await clean();
  await superPool.end();
  await appPool.end();
  await relayPool.end();
  if (failures) {
    console.error(`\npublic-accounts: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("\npublic-accounts: all passed");
}

main().catch((e) => {
  console.error("public-accounts seam ERROR", e);
  process.exit(1);
});
