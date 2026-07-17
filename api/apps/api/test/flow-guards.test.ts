import pg from "pg";
import { appPool, relayPool } from "@repo/db";
import { isPrivateAddr, assertPublicUrl, assertResolvedPublic, redactSecrets } from "@repo/flow-core";
import { assertEgressAllowed } from "../src/automations/items.js";
import { createAutomation, updateAutomation, deleteAutomation } from "../src/automations/store.js";

// Studio/Studio Phase 5 — execution security core. Proves the SSRF/egress guards that make the
// item-flow http node safe to run per-tenant: literal private-range blocking, the DNS-rebinding
// guard (a public name resolving into a private range), per-tenant egress allow/deny policy
// (0082 flow_egress_rules, RLS-scoped), and secret redaction on persisted errors. Postgres only.

const A = "33333333-3333-3333-3333-333333333333"; // TestCo (dedicated test tenant)
const B = "22222222-2222-2222-2222-222222222222"; // Globex

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}
async function throws(name: string, fn: () => Promise<void> | void) {
  try { await fn(); check(name, false); } catch { check(name, true); }
}
async function ok(name: string, fn: () => Promise<void> | void) {
  try { await fn(); check(name, true); } catch (e) { check(name, false); console.error("   ", (e as Error).message); }
}

async function main() {
  const superPool = new pg.Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME, user: process.env.DB_SUPER_USER, password: process.env.DB_SUPER_PASSWORD, max: 2,
  });
  const clean = () => superPool.query("DELETE FROM flow_egress_rules WHERE pattern LIKE 'fgtest-%' OR pattern LIKE '%fgtest%'");
  const addRule = (tenant: string, pattern: string, mode: "allow" | "deny") =>
    superPool.query(
      "INSERT INTO flow_egress_rules (tenant_id, pattern, mode) VALUES ($1, $2, $3)",
      [tenant, pattern, mode],
    );
  await clean();

  // ── literal SSRF blocklist (isPrivateAddr + assertPublicUrl) ──
  check("isPrivateAddr: loopback v4", isPrivateAddr("127.0.0.1"));
  check("isPrivateAddr: 10/8", isPrivateAddr("10.1.2.3"));
  check("isPrivateAddr: 172.16/12", isPrivateAddr("172.16.5.5") && isPrivateAddr("172.31.0.1"));
  check("isPrivateAddr: 172.32 is public", !isPrivateAddr("172.32.0.1"));
  check("isPrivateAddr: 192.168", isPrivateAddr("192.168.0.1"));
  check("isPrivateAddr: cloud metadata 169.254.169.254", isPrivateAddr("169.254.169.254"));
  check("isPrivateAddr: CGNAT 100.64/10", isPrivateAddr("100.64.0.1"));
  check("isPrivateAddr: IPv4-mapped ::ffff:127.0.0.1", isPrivateAddr("::ffff:127.0.0.1"));
  check("isPrivateAddr: IPv6 loopback ::1", isPrivateAddr("::1"));
  check("isPrivateAddr: IPv6 ULA fd00", isPrivateAddr("fd12:3456::1"));
  check("isPrivateAddr: public v4 is NOT private", !isPrivateAddr("93.184.216.34"));

  throws("assertPublicUrl: rejects http to 169.254.169.254", () => assertPublicUrl("http://169.254.169.254/latest/meta-data"));
  throws("assertPublicUrl: rejects file://", () => assertPublicUrl("file:///etc/passwd"));
  throws("assertPublicUrl: rejects bare hostname (no dot)", () => assertPublicUrl("http://localhost:8080"));
  throws("assertPublicUrl: rejects 127.0.0.1", () => assertPublicUrl("http://127.0.0.1"));
  ok("assertPublicUrl: allows a public https URL", () => assertPublicUrl("https://api.example.com/v1"));

  // ── DNS-rebinding guard: a public NAME that resolves into a private range is blocked ──
  const rebindResolver = async (_h: string) => ["169.254.169.254"];
  const publicResolver = async (_h: string) => ["93.184.216.34"];
  await throws("assertResolvedPublic: blocks a name resolving to metadata IP", () =>
    assertResolvedPublic("http://evil.example.com/", rebindResolver));
  await ok("assertResolvedPublic: allows a name resolving to a public IP", () =>
    assertResolvedPublic("https://good.example.com/", publicResolver));
  await throws("assertResolvedPublic: still blocks a literal private IP host", () =>
    assertResolvedPublic("http://10.0.0.5/", publicResolver));

  // ── per-tenant egress policy (0082) ──
  await ok("egress: no rules → default-open", () => assertEgressAllowed(A, "https://anything.example.com/x"));

  await addRule(A, "fgtest-api.stripe.com", "allow"); // exact-host allow (prefixed so cleanup finds it)
  await addRule(A, "*.fgtest-acme.com", "allow");     // glob allow
  await ok("egress: allowlisted exact host passes", () => assertEgressAllowed(A, "https://fgtest-api.stripe.com/charge"));
  await ok("egress: allowlisted glob host passes", () => assertEgressAllowed(A, "https://x.fgtest-acme.com/"));
  await throws("egress: once an allowlist exists, an off-list host is blocked", () =>
    assertEgressAllowed(A, "https://evil.example.com/"));
  await throws("egress: glob does not span a dot boundary", () =>
    assertEgressAllowed(A, "https://a.b.fgtest-acme.com/"));

  await addRule(A, "bad.fgtest-deny.com", "deny");
  // Deny wins even if it would otherwise be off-list-blocked anyway; prove an explicit deny with an
  // allow that would match: add an allow that covers it, deny still blocks.
  await addRule(A, "*.fgtest-deny.com", "allow");
  await throws("egress: deny always blocks even with a matching allow", () =>
    assertEgressAllowed(A, "https://bad.fgtest-deny.com/"));
  await ok("egress: a sibling under the allow-glob (not denied) passes", () =>
    assertEgressAllowed(A, "https://ok.fgtest-deny.com/"));

  // Tenant isolation: B has no rules, so A's allowlist doesn't constrain B.
  await ok("egress: B (no rules) is unaffected by A's allowlist", () => assertEgressAllowed(B, "https://evil.example.com/"));

  // ── flow versioning (0081): save bumps version + snapshots the graph ──
  {
    const g1 = { nodes: [{ id: "t", type: "trigger" as const, config: {} }], edges: [] };
    const g2 = { nodes: [{ id: "t", type: "trigger" as const, config: {} }, { id: "h", type: "item" as const, config: { kind: "setVar", name: "x", value: "1" } }], edges: [{ from: "t", to: "h" }] };
    const a = await createAutomation(A, { name: "fgtest-versioning", trigger: "manual", enabled: true, conditions: { match: "all", conditions: [] }, actions: [], graph: g1 });
    check("versioning: new automation is version 1", a.version === 1);
    const v1 = await superPool.query("SELECT count(*)::int n FROM automation_versions WHERE automation_id = $1", [a.id]);
    check("versioning: create snapshots one version row", v1.rows[0].n === 1);

    const b = await updateAutomation(A, a.id, { graph: g2 });
    check("versioning: a graph edit bumps to version 2", b?.version === 2);
    const v2 = await superPool.query("SELECT count(*)::int n FROM automation_versions WHERE automation_id = $1", [a.id]);
    check("versioning: the edit snapshots a second row", v2.rows[0].n === 2);

    const c2 = await updateAutomation(A, a.id, { name: "fgtest-versioning-renamed" });
    check("versioning: a non-graph edit does NOT bump the version", c2?.version === 2);
    const v3 = await superPool.query("SELECT count(*)::int n FROM automation_versions WHERE automation_id = $1", [a.id]);
    check("versioning: a non-graph edit adds no snapshot", v3.rows[0].n === 2);

    await superPool.query("DELETE FROM automation_versions WHERE automation_id = $1", [a.id]);
    await deleteAutomation(A, a.id);
  }

  // ── quota accounting (0082 flow_usage): the counter increments per call ──
  {
    await superPool.query("DELETE FROM flow_usage WHERE tenant_id = $1 AND kind = 'fgtest'", [A]);
    const bump = () => superPool.query(
      `INSERT INTO flow_usage (tenant_id, day, kind, count) VALUES ($1, current_date, 'fgtest', 1)
       ON CONFLICT (tenant_id, day, kind) DO UPDATE SET count = flow_usage.count + 1 RETURNING count`, [A]);
    const r1 = await bump(); const r2 = await bump();
    check("quota: flow_usage upsert accrues per call", r1.rows[0].count === 1 && r2.rows[0].count === 2);
    const iso = await superPool.query("SELECT count(*)::int n FROM flow_usage WHERE tenant_id = $1 AND kind = 'fgtest'", [B]);
    check("quota: usage is tenant-scoped (B has none of A's)", iso.rows[0].n === 0);
    await superPool.query("DELETE FROM flow_usage WHERE kind = 'fgtest'");
  }

  // ── secret redaction ──
  check("redactSecrets: strips sk-ant key", redactSecrets("boom sk-ant-abc123DEF end").includes("sk-ant-***"));
  check("redactSecrets: strips Bearer token", /Bearer \*\*\*/.test(redactSecrets("auth Bearer eyJhbGciOi.abc.def")));
  check("redactSecrets: leaves clean text alone", redactSecrets("nothing secret here") === "nothing secret here");

  await clean();
  await superPool.end();
  await appPool.end();
  await relayPool.end();

  if (failures > 0) { console.error(`\nFLOW-GUARDS: ${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nFLOW-GUARDS: all checks passed");
}

main().catch((e) => { console.error("flow-guards ERROR", e); process.exit(1); });
