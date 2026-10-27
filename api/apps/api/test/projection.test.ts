import pg from "pg";
import { appPool, relayPool } from "@repo/db";
import { mapMemberRole, projectOrganization, projectMember, unprojectMember } from "../src/projection.js";

// Reverse identity projection (better-auth → app tenants/users) seam + its §9 guarantees:
//   • mapMemberRole is an allowlist (§9.3) — never trusts the raw member.role;
//   • projectOrganization / projectMember upsert idempotently through withTenant (app_user,
//     RLS-bound — §9.1/§9.2), NOT a bypass;
//   • a write is tenant-scoped: it lands in the target tenant only, and the global
//     users_email_key is the DB backstop that makes a 2nd-tenant projection fail loudly
//     (§9.5a, the multi-org block);
//   • unprojectMember removes only the target tenant's row.
// Synthetic tenant/user UUIDs (never the seeded Acme/Globex data). Needs Postgres only.

const T1 = "aaaaaaaa-0000-4000-8000-0000000000a1";
const T2 = "aaaaaaaa-0000-4000-8000-0000000000a2";
const U1 = "bbbbbbbb-0000-4000-8000-0000000000b1";
const U2 = "bbbbbbbb-0000-4000-8000-0000000000b2";
const B = "22222222-2222-2222-2222-222222222222"; // Globex (seeded) — for the cross-tenant guard

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
    await superPool.query(`DELETE FROM users WHERE tenant_id IN ($1,$2) OR email LIKE 'projtest-%@projtest.local'`, [T1, T2]);
    await superPool.query(`DELETE FROM tenants WHERE id IN ($1,$2)`, [T1, T2]);
  };
  await clean();

  // ---- mapMemberRole allowlist (§9.3) ----
  check("mapMemberRole passes recognised roles verbatim",
    ["owner", "admin", "agent", "viewer"].every((r) => mapMemberRole(r) === r));
  check("mapMemberRole maps studio 'member' → agent", mapMemberRole("member") === "agent");
  check("mapMemberRole maps unknown / null / '' → agent",
    mapMemberRole("superadmin") === "agent" && mapMemberRole(null) === "agent" && mapMemberRole("") === "agent");
  check("mapMemberRole picks the first recognised token from a comma list",
    mapMemberRole("viewer,admin") === "viewer" && mapMemberRole("junk,owner") === "owner");
  check("mapMemberRole is case-insensitive", mapMemberRole("OWNER") === "owner");

  // ---- projectOrganization → tenants mirror (idempotent upsert) ----
  await projectOrganization({ id: T1, name: "ProjTest Org" });
  const t1 = await superPool.query("SELECT name FROM tenants WHERE id = $1", [T1]);
  check("projectOrganization inserts the tenants mirror", t1.rows[0]?.name === "ProjTest Org");
  await projectOrganization({ id: T1, name: "ProjTest Renamed" });
  const t1b = await superPool.query("SELECT count(*)::int n, max(name) name FROM tenants WHERE id = $1", [T1]);
  check("projectOrganization is idempotent + updates the name", t1b.rows[0].n === 1 && t1b.rows[0].name === "ProjTest Renamed");

  // ---- projectMember → users roster (tenant-scoped, role-mapped) ----
  await projectMember(T1, U1, "projtest-1@projtest.local", "Proj One", "owner");
  const u1 = await superPool.query("SELECT tenant_id, email, name, role FROM users WHERE tenant_id = $1 AND id = $2", [T1, U1]);
  check("projectMember inserts the roster row with mapped role (owner)",
    u1.rows[0]?.email === "projtest-1@projtest.local" && u1.rows[0]?.role === "owner" && u1.rows[0]?.name === "Proj One");
  await projectMember(T1, U1, "projtest-1@projtest.local", "Proj One Renamed", "member");
  const u1b = await superPool.query("SELECT count(*)::int n, max(name) name, max(role) role FROM users WHERE tenant_id = $1 AND id = $2", [T1, U1]);
  check("projectMember upserts (no dup) + maps 'member'→agent + updates name",
    u1b.rows[0].n === 1 && u1b.rows[0].role === "agent" && u1b.rows[0].name === "Proj One Renamed");

  // ---- tenant-scoped: the write landed ONLY in T1 ----
  const bLeak = await superPool.query("SELECT 1 FROM users WHERE tenant_id = $1 AND id = $2", [B, U1]);
  check("projectMember did not leak the row into another tenant", bLeak.rowCount === 0);

  // ---- §9.5a: the global users_email_key blocks the same identity in a 2nd tenant ----
  await projectOrganization({ id: T2, name: "ProjTest Two" });
  let multiOrgRejected = false;
  try {
    await projectMember(T2, U2, "projtest-1@projtest.local", "Dup Email", "agent"); // same email, different tenant
  } catch (e) {
    multiOrgRejected = (e as { code?: string }).code === "23505";
  }
  check("projecting one email into a second tenant is rejected by users_email_key (multi-org backstop)", multiOrgRejected);

  // ---- unprojectMember is tenant-scoped ----
  await unprojectMember(B, U1); // wrong tenant — must NOT remove T1's row
  const stillThere = await superPool.query("SELECT 1 FROM users WHERE tenant_id = $1 AND id = $2", [T1, U1]);
  check("unprojectMember(wrong tenant) leaves the row intact", stillThere.rowCount === 1);
  await unprojectMember(T1, U1);
  const gone = await superPool.query("SELECT 1 FROM users WHERE tenant_id = $1 AND id = $2", [T1, U1]);
  check("unprojectMember(own tenant) removes the roster row", gone.rowCount === 0);

  await clean();
  await superPool.end();
  await appPool.end();
  await relayPool.end();

  if (failures > 0) { console.error(`\nPROJECTION: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nPROJECTION: all checks green");
}

main().catch((e) => { console.error("projection seam ERROR", e); process.exit(1); });
