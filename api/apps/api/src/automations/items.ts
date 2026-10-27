// ── Item-flow node executor — thin api adapter over @repo/flow-core ────────────────────────────
// The item-node DATA-PLANE + node library (httpRequest/setVar/setFields/filter/merge/aggregate/
// ifCond/code) + templating + evalCondition + assertPublicUrl + withTimeout + redactSecrets live in
// @repo/flow-core (DB-free, so the SAME implementation also bundles into the flow-runner container).
// This file is the api-side glue only: it re-exports the shared helpers under the names Studio's
// runGraph uses, and wraps the pure executor with the api's dry-run gate + ActionResult typing.
//
// Templating rides ctx.text/json/item (hydrated by runGraph before each node), so studio tokens
// ({{text}}, {{json.a.b}}) and Studio tokens ({{subject}}, {{vars.x}}, {{steps.<id>.<field>}})
// resolve through the one shared interpolate.
import dns from "node:dns/promises";
import { withTenant } from "@repo/db";
import { interpolate } from "./conditions.js";
import { itemNodeSuppressed } from "./registry.js";
import {
  type Item,
  type RunItemHooks,
  runItemNode as coreRunItemNode,
  seedItem,
  hydrateCtxItem,
  inputItemsFor,
  needsBrowser,
} from "@repo/flow-core";
import type { Ctx } from "./conditions.js";
import type { ActionResult, ExecOpts } from "../automations.js";

// Re-export the shared data-plane surface runGraph consumes, so its import site is unchanged.
export { type Item, seedItem, hydrateCtxItem, inputItemsFor, needsBrowser };

/** Compile a host glob (`api.stripe.com`, `*.acme.com`) to an anchored, case-insensitive regex. */
function hostGlobToRe(pattern: string): RegExp {
  const esc = pattern.trim().toLowerCase().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^.]+");
  return new RegExp(`^${esc}$`, "i");
}

/**
 * Per-tenant egress policy (0082 `flow_egress_rules`). A `deny` match ALWAYS blocks. If the tenant
 * has ANY `allow` rule, the host must match one (default-deny once an allowlist exists); with no
 * allow rules, anything not explicitly denied is permitted (default-open until a tenant opts in).
 * Read under the tenant's RLS context. Throws to block — the httpRequest node maps it to a failure.
 */
export async function assertEgressAllowed(tenantId: string, url: string): Promise<void> {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { throw new Error("invalid URL"); }
  const rules = await withTenant(tenantId, async (c) => {
    const r = await c.query<{ pattern: string; mode: string }>(
      "SELECT pattern, mode FROM flow_egress_rules WHERE tenant_id = current_tenant()",
    );
    return r.rows;
  });
  if (!rules.length) return; // no policy configured → default-open
  for (const rule of rules) {
    if (rule.mode === "deny" && hostGlobToRe(rule.pattern).test(host)) {
      throw new Error(`egress denied by policy: ${host}`);
    }
  }
  const allows = rules.filter((r) => r.mode === "allow");
  if (allows.length && !allows.some((r) => hostGlobToRe(r.pattern).test(host))) {
    throw new Error(`egress not on the allowlist: ${host}`);
  }
}

/** Per-tenant daily http-call ceiling (a hostile or runaway flow can't hammer the shared api). */
const HTTP_MAX_PER_DAY = Math.max(Number(process.env.FLOW_HTTP_MAX_PER_DAY) || 5000, 1);

/** Increment a tenant's rolling per-day usage counter (0082 `flow_usage`) and enforce the http
 *  ceiling. Increment-then-check so the cap is a hard stop; throws when exceeded (the http node
 *  maps it to a failure). Other kinds accrue for observability without a cap here. */
async function bumpUsage(tenantId: string, kind: string): Promise<void> {
  const n = await withTenant(tenantId, async (c) => {
    const r = await c.query<{ count: number }>(
      `INSERT INTO flow_usage (tenant_id, day, kind, count) VALUES (current_tenant(), current_date, $1, 1)
       ON CONFLICT (tenant_id, day, kind) DO UPDATE SET count = flow_usage.count + 1
       RETURNING count`,
      [kind],
    );
    return r.rows[0].count as number;
  });
  if (kind === "http" && n > HTTP_MAX_PER_DAY) throw new Error(`daily http quota exceeded (${HTTP_MAX_PER_DAY})`);
}

/** The api-side execution hooks: a real DNS resolver (DNS-rebinding guard), the tenant's egress
 *  policy, and per-tenant usage accounting. flow-core calls these but can't own them (DB + DNS live
 *  outside the dep-free core). */
function apiHooks(tenantId: string): RunItemHooks {
  return {
    resolveHost: async (h) => (await dns.lookup(h, { all: true })).map((a) => a.address),
    assertEgress: (url) => assertEgressAllowed(tenantId, url),
    bumpUsage: (kind) => bumpUsage(tenantId, kind),
  };
}

/**
 * Execute one in-process item node: array-in → array-out (+ optional `fired` handle for ifCond).
 * The node semantics come from @repo/flow-core; this adapter adds the api-only concerns:
 *  • the dry-run gate for `httpRequest` (a write verb is suppressed, reporting what it *would* do);
 *  • the ActionResult typing runGraph's trace expects (flow-core's {type,ok,detail} is a subset).
 * Browser/AI kinds run in the flow container (`needsBrowser` delegates the whole graph), never here.
 */
export async function runItemNode(
  tenantId: string,
  kind: string,
  config: Record<string, unknown>,
  inputs: Item[],
  ctx: Ctx,
  opts: ExecOpts,
): Promise<{ items: Item[]; result: ActionResult; fired?: "true" | "false" }> {
  // Dry-run gate: a GET reads (runs), a write verb mutates (suppressed). Only httpRequest is
  // effect-bearing among the deterministic kinds, so it's the only gated one.
  if (kind === "httpRequest" && opts.dryRun && itemNodeSuppressed(kind, config)) {
    const method = String(config.method ?? "GET").toUpperCase();
    const url = interpolate(String(config.url ?? ""), ctx).trim();
    return {
      items: inputs,
      result: { type: "httpRequest", ok: true, detail: `[dry-run] would ${method} ${url.slice(0, 60)}` },
    };
  }
  // flow-core's FlowNodeResult ({type,ok,detail}) is structurally an ActionResult. The SSRF/egress
  // guards + usage accounting run via the injected hooks.
  const hooks = apiHooks(tenantId);
  // Per-node retries (studio's __retry/__retryWait, reliability §9): re-run on a failed result up to
  // __retry times (cap 5) with a bounded wait between. A run-scoped variable / a flaky upstream API
  // recovers without a whole-flow re-trigger. Retries re-invoke the hooks, so each attempt re-checks
  // egress + bumps usage — intended (a retry IS another call).
  const maxRetry = Math.min(Math.max(Math.trunc(Number(config.__retry) || 0), 0), 5);
  const wait = Math.min(Math.max(Math.trunc(Number(config.__retryWait) || 0), 0), 10_000);
  let out = await coreRunItemNode(kind, config, inputs, ctx, hooks);
  let attempt = 0;
  while (!out.result.ok && attempt < maxRetry) {
    attempt++;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    out = await coreRunItemNode(kind, config, inputs, ctx, hooks);
  }
  if (attempt > 0 && !out.result.ok) {
    out = { ...out, result: { ...out.result, detail: `${out.result.detail} (after ${attempt} ${attempt === 1 ? "retry" : "retries"})` } };
  }
  return out;
}
