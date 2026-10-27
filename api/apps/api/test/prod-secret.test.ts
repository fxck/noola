import { prodSecret } from "../src/prod-secret.js";

// Fail-fast prod-secret guard: in production a missing or dev-default secret must REFUSE to boot;
// in dev/stage the dev default is returned so nothing changes. prodSecret reads NODE_ENV at call
// time, so we toggle it per case.

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}`); }
}
function threw(fn: () => unknown): boolean {
  try { fn(); return false; } catch { return true; }
}

const savedEnv = process.env.NODE_ENV;

// ── development: dev default is fine, nothing throws ──────────────────────────
process.env.NODE_ENV = "development";
check("dev: missing secret returns dev default", prodSecret("X", undefined, "dev-default") === "dev-default");
check("dev: real value returned", prodSecret("X", "real-secret", "dev-default") === "real-secret");
check("dev: does not throw on missing", !threw(() => prodSecret("X", undefined, "dev-default")));

// ── production: missing or dev-default secret must throw at the call site ─────
process.env.NODE_ENV = "production";
check("prod: missing secret THROWS", threw(() => prodSecret("AUTH_SECRET", undefined, "dev-default")));
check("prod: value === dev default THROWS", threw(() => prodSecret("AUTH_SECRET", "dev-default", "dev-default")));
check("prod: empty string THROWS", threw(() => prodSecret("AUTH_SECRET", "", "dev-default")));
check("prod: a real non-default value passes", prodSecret("AUTH_SECRET", "a-real-prod-secret", "dev-default") === "a-real-prod-secret");
check("prod: chained fallback (A||B) real value passes", prodSecret("X", (undefined as string | undefined) || "from-model-key", "dev-default") === "from-model-key");

process.env.NODE_ENV = savedEnv;
console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS");
process.exit(failures ? 1 : 0);
