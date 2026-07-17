import type { IncomingHttpHeaders } from "node:http";
import { appPool, relayPool, authPool } from "@repo/db";
import { hashPassword, verifyPassword } from "../src/auth.js";
import { betterAuthLogin, betterAuthLogout, resolveBetterAuthSession } from "../src/betterauth.js";

// Auth seam gate (Track A #2, Slice 3 — better-auth AUTHORITATIVE): the scrypt password
// bridge, authoritative login through better-auth, and Bearer-token → server-authoritative
// tenant. Runs against the dev DB where the demo users are projected into the better-auth
// identity tables. Exit 1 on any fail.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const DEMO_PW = "demo1234";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.error(`  FAIL  ${name}`);
  }
}

function bearer(token: string | undefined): IncomingHttpHeaders {
  return { authorization: `Bearer ${token ?? ""}` } as IncomingHttpHeaders;
}

async function main() {
  // 1 — scrypt bridge (better-auth hashes/verifies through these)
  const h = await hashPassword(DEMO_PW);
  check("scrypt verify true for the correct password", await verifyPassword(DEMO_PW, h));
  check("scrypt verify false for a wrong password", !(await verifyPassword("nope", h)));
  check("verify false for a null hash", !(await verifyPassword("x", null)));
  check("two hashes of the same password differ (salted)", h !== (await hashPassword(DEMO_PW)));

  // 2 — authoritative login through better-auth (scrypt bridge + projected demo user)
  const bad = await betterAuthLogin("tess@testco.test", "wrongpass");
  check("login with the wrong password → null", bad === null);
  const ok = await betterAuthLogin("tess@testco.test", DEMO_PW);
  check("login with the correct password → token + user", !!ok?.token && !!ok?.user);
  check("returned user carries the server-derived tenant (Acme)", ok?.user.tenantId === A);
  check("returned user does not leak a password hash", !!ok && !("password_hash" in (ok.user as object)));

  // 3 — the Bearer token resolves to the same server-authoritative session
  const s = ok ? await resolveBetterAuthSession(bearer(ok.token)) : null;
  check("resolved session tenant is server-derived (Acme)", s?.tenantId === A);
  check("resolved session carries the org-scoped role", s?.role === "agent" || s?.role === "owner");
  check("resolved session userId matches the app user id", !!s && s.userId === ok?.user.id);

  // 4 — a bogus Bearer resolves to null (fail-closed → the global gate 401s)
  const none = await resolveBetterAuthSession(bearer("not-a-real-token"));
  check("bogus Bearer → null session", none === null);

  // 5 — logout revokes the session (the token no longer resolves)
  if (ok) {
    await betterAuthLogout(bearer(ok.token));
    const after = await resolveBetterAuthSession(bearer(ok.token));
    check("session no longer resolves after logout", after === null);
  }

  await appPool.end();
  await relayPool.end();
  await authPool.end();

  if (failures > 0) {
    console.error(`\nAUTH: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAUTH: all checks green");
}

main().catch((e) => {
  console.error("auth seam ERROR", e);
  process.exit(1);
});
