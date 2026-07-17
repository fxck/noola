import { roleAtLeast, routeFloor, ADMIN_ROUTES, ROLE_RANK } from "../src/rbac.js";

// RBAC policy seam: the role hierarchy comparison and the per-route floor that the global gate
// (server.ts) enforces. Pure logic — no DB, no HTTP. The end-to-end 403 is exercised in the
// browser pass; this pins the authorization rules themselves.

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}

// ---- role hierarchy ----
check("rank order viewer < agent < admin < owner",
  ROLE_RANK.viewer < ROLE_RANK.agent && ROLE_RANK.agent < ROLE_RANK.admin && ROLE_RANK.admin < ROLE_RANK.owner);
check("owner satisfies every floor",
  ["viewer", "agent", "admin", "owner"].every((m) => roleAtLeast("owner", m)));
check("admin satisfies admin/agent/viewer but not owner",
  roleAtLeast("admin", "admin") && roleAtLeast("admin", "agent") && roleAtLeast("admin", "viewer") && !roleAtLeast("admin", "owner"));
check("agent satisfies agent/viewer, not admin",
  roleAtLeast("agent", "agent") && roleAtLeast("agent", "viewer") && !roleAtLeast("agent", "admin"));
check("viewer satisfies only viewer",
  roleAtLeast("viewer", "viewer") && !roleAtLeast("viewer", "agent"));
check("unknown / missing role satisfies nothing (deny-by-default)",
  !roleAtLeast("superadmin", "viewer") && !roleAtLeast(undefined, "viewer") && !roleAtLeast(null, "viewer"));

// ---- per-route floor ----
check("reads floor at viewer",
  routeFloor("GET", "/tickets") === "viewer" && routeFloor("GET", "/settings/model") === "viewer" && routeFloor("HEAD", "/kb") === "viewer");
check("ordinary business mutations floor at agent",
  routeFloor("POST", "/tickets/:id/reply") === "agent" &&
  routeFloor("POST", "/contacts") === "agent" &&
  routeFloor("PATCH", "/kb/:id") === "agent" &&
  routeFloor("POST", "/sources") === "agent" &&
  routeFloor("POST", "/broadcasts") === "agent");
check("admin surfaces floor at admin",
  routeFloor("PUT", "/settings/model") === "admin" &&
  routeFloor("PUT", "/autoreply/policy") === "admin" &&
  routeFloor("POST", "/slack/connections") === "admin" &&
  routeFloor("POST", "/webhooks") === "admin" &&
  routeFloor("DELETE", "/webhooks/:id") === "admin" &&
  routeFloor("POST", "/broadcasts/:id/send") === "admin");
check("member + invite management floors at admin",
  routeFloor("POST", "/members/invites") === "admin" &&
  routeFloor("DELETE", "/members/invites/:id") === "admin" &&
  routeFloor("POST", "/members/invite-links") === "admin" &&
  routeFloor("PATCH", "/members/:id/role") === "admin" &&
  routeFloor("DELETE", "/members/:id") === "admin");
check("GET /members (roster read) stays agent-visible (viewer floor)",
  routeFloor("GET", "/members") === "viewer");
check("broadcast compose is agent but send is admin (send has higher blast radius)",
  routeFloor("POST", "/broadcasts") === "agent" && ADMIN_ROUTES.has("POST /broadcasts/:id/send"));

if (failures > 0) { console.error(`\nRBAC: ${failures} check(s) FAILED`); process.exit(1); }
console.log("\nRBAC: all checks green");
