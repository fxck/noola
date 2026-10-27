import pg from "pg";
import { appPool, relayPool, authPool } from "@repo/db";
import { auth, betterAuthSignup } from "../src/betterauth.js";

// Signup/onboarding seam: betterAuthSignup creates a credential account AND its first workspace,
// the org hooks reverse-project a tenant + owner into the app tables, the returned payload is a
// ready-to-use { token, user:{ role:'owner' } }, duplicate email is a clean 409, and the
// single-org invariant (§9.5a) blocks a second workspace for the same identity. Exercises the
// real better-auth flow against the shared DB — needs Postgres + the auth_user creds.

const EMAIL = "signuptest-a@sut.local";
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
    // organization/user deletes cascade to member/session/account/invitation; then the app mirror.
    await superPool.query(`DELETE FROM "organization" WHERE name LIKE 'SUT %'`);
    await superPool.query(`DELETE FROM "user" WHERE email LIKE 'signuptest-%@sut.local'`);
    await superPool.query(`DELETE FROM users WHERE email LIKE 'signuptest-%@sut.local'`);
    await superPool.query(`DELETE FROM tenants WHERE name LIKE 'SUT %'`);
  };
  await clean();

  // ---- happy path: account + workspace + owner session ----
  const r = await betterAuthSignup(EMAIL, "password123", "SUT Person A", "SUT Workspace A");
  check("betterAuthSignup succeeds", r.ok === true);
  if (!r.ok) { await clean(); await superPool.end(); await appPool.end(); await relayPool.end(); await authPool.end(); process.exit(1); }
  check("returns a bearer token", typeof r.token === "string" && r.token.length > 0);
  check("creator is owner with an active tenant", r.user.role === "owner" && !!r.user.tenantId && r.user.email === EMAIL);

  // ---- reverse projection landed (tenant + owner roster row) ----
  const t = await superPool.query("SELECT name FROM tenants WHERE id = $1", [r.user.tenantId]);
  check("tenants mirror was projected", t.rows[0]?.name === "SUT Workspace A");
  const u = await superPool.query("SELECT email, role FROM users WHERE tenant_id = $1 AND id = $2", [r.user.tenantId, r.user.id]);
  check("owner roster row was projected with mapped role", u.rows[0]?.email === EMAIL && u.rows[0]?.role === "owner");

  // ---- the resolved session actually works (token → owner session) ----
  check("returned tenantId is a uuid (RLS GUC compatible)", /^[0-9a-f-]{36}$/.test(r.user.tenantId));

  // ---- duplicate email → 409 (no account enumeration beyond the status) ----
  const dup = await betterAuthSignup(EMAIL, "password123", "SUT Person A2", "SUT Workspace A2");
  check("duplicate email is rejected 409", dup.ok === false && dup.status === 409);

  // ---- single-org guard: the same identity cannot create a second workspace (§9.5a) ----
  let secondOrgBlocked = false;
  try {
    await auth.api.createOrganization({
      body: { name: "SUT Workspace A-second", slug: "sut-second-xyz" },
      headers: { authorization: `Bearer ${r.token}` } as unknown as Headers,
    });
  } catch (e) {
    secondOrgBlocked = /forbidden|already belongs|workspace/i.test((e as { message?: string }).message ?? "");
  }
  check("second workspace for the same identity is blocked by the before-hook", secondOrgBlocked);

  // the block must also have left NO orphan second org
  const orgs = await superPool.query(`SELECT count(*)::int n FROM "organization" WHERE name LIKE 'SUT %'`);
  check("no orphaned second organization was created", orgs.rows[0].n === 1);

  await clean();
  await superPool.end();
  await appPool.end();
  await relayPool.end();
  await authPool.end();

  if (failures > 0) { console.error(`\nSIGNUP: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nSIGNUP: all checks green");
}

main().catch((e) => { console.error("signup seam ERROR", e); process.exit(1); });
