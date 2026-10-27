// ── @repo/flow-core — DB-free single source of truth for item-node execution ──────────────────
// The Studio→Studio item data-plane + the deterministic (non-browser) node library, extracted so the
// api's in-process executor (apps/api/src/automations/items.ts) AND the containerized flow-runner
// (runner/flow-runner/exec.mts) share ONE implementation instead of two copies that drift.
//
// PURE TypeScript, ZERO dependencies beyond node builtins (`node:vm`): no @repo/db, no conditions
// layer, no ctx carrying DB handles. That is what lets esbuild inline this whole module into the
// flow-runner container bundle. The DB/tenant/ActionResult glue stays in the api adapter; the
// browser + AI-browser nodes (Playwright/Stagehand) stay container-only in exec.mts.
import vm from "node:vm";

/** The canonical data-plane unit — identical to studio (`run.ts:177`). */
export type Item = { json: unknown; text: string };

/** A run context: an arbitrary record with an optional `vars` sub-store. Both callers pass their
 *  own richer ctx (the api's `Ctx`, the runner's ambient ctx); this is the DB-free floor. */
export type FlowCtx = Record<string, unknown> & { vars?: Record<string, unknown> };

/** The DB-free result of one item node — structurally a subset of the api's ActionResult. */
export interface FlowNodeResult { type: string; ok: boolean; detail: string }
export interface RunItemNodeResult { items: Item[]; result: FlowNodeResult; fired?: "true" | "false" }

/** Host-side hooks the pure executor calls but can't implement itself (DB / DNS / quota live outside
 *  the dep-free core). The api passes tenant-bound implementations; the container passes its own
 *  (DNS resolver + the tenant's egress rules injected via env). All optional — omitted = no-op. */
export interface RunItemHooks {
  /** Resolve a hostname to its IP strings — powers the DNS-rebinding guard. */
  resolveHost?: (host: string) => Promise<string[]>;
  /** Per-tenant egress allow/deny; throws to block the URL. */
  assertEgress?: (url: string) => Promise<void> | void;
  /** Usage accounting for quotas; called once per effectful op (http/run/…). */
  bumpUsage?: (kind: string) => Promise<void> | void;
}

/** Browser/AI kinds that require a real Chromium (Playwright/Stagehand) — they run in the
 *  flow-runner container, not in the api process. Kept in lockstep with contracts' FLOW_BROWSER_KINDS
 *  (this copy is dependency-free so the container bundle needs no @repo/contracts/zod). */
export const FLOW_BROWSER_KINDS = new Set<string>([
  "openUrl", "navBack", "navForward", "reload", "waitFor", "clickSelector", "typeText", "selectOption",
  "hover", "scroll", "pressKey", "getText", "screenshot", "act", "observe", "extract", "agent",
]);

/** The deterministic (non-browser) item kinds `runItemNode` handles — the exact set that runs
 *  identically in-process (api) and in the flow container (runner). The container uses this to
 *  decide which nodes to delegate to the shared executor vs. handle with its own browser drivers. */
export const FLOW_DETERMINISTIC_ITEM_KINDS = new Set<string>([
  "httpRequest", "setVar", "setFields", "filter", "merge", "aggregate", "ifCond", "code",
]);

export const tryJson = (t: string): unknown => { try { return JSON.parse(t); } catch { return t; } };
export const safeStringify = (v: unknown): string => { try { return JSON.stringify(v); } catch { return String(v); } };

/** Read a value out of an item by path: 'text', 'json' (whole), or 'json.a.b'. Port of
 *  studio's itemValue (`run.ts:186-198`). */
export function itemValue(item: Item | undefined, pathStr: string): string {
  const p = (pathStr || "text").trim();
  if (p === "text") return item?.text ?? "";
  if (p === "json") { try { return JSON.stringify(item?.json); } catch { return ""; } }
  const path = p.startsWith("json.") ? p.slice(5) : p;
  let cur: unknown = item?.json;
  for (const seg of path.split(".")) {
    if (cur == null || typeof cur !== "object") return "";
    cur = (cur as Record<string, unknown>)[seg];
  }
  if (cur == null) return "";
  return typeof cur === "string" ? cur : typeof cur === "object" ? JSON.stringify(cur) : String(cur);
}

/** Resolve a possibly-dotted path in the context — a flat field (`subject`) or a nested step
 *  output (`steps.<nodeId>.<field>`) for graph data-passing. */
function resolvePath(ctx: Record<string, unknown>, path: string): unknown {
  if (path in ctx) return ctx[path];
  return path.split(".").reduce<unknown>(
    (o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]),
    ctx as unknown,
  );
}

/** Interpolate {{field}} / {{steps.<id>.<field>}} tokens from the context into a template. The
 *  single templating resolver shared by the api (re-exported from conditions.ts) and the runner. */
export function interpolate(tpl: string, ctx: Record<string, unknown>): string {
  return (tpl ?? "").replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, k: string) => {
    const v = resolvePath(ctx, k);
    return v == null ? "" : String(v);
  });
}

/** The seed item for a graph run = the ticket-shaped ctx: the whole record as `json`, the latest
 *  customer message as `text`. So a domain trigger's first item is `{{json.subject}}` / `{{text}}`. */
export function seedItem(ctx: Record<string, unknown>): Item {
  return { json: { ...ctx }, text: String(ctx.body ?? "") };
}

/** Hydrate the ambient item onto ctx so `interpolate` resolves studio tokens. Purely additive keys
 *  (ctx.item/json/text) — no existing action reads them, so no domain-flow regression. */
export function hydrateCtxItem(ctx: Record<string, unknown>, item: Item | undefined): void {
  const it = item ?? { json: {}, text: "" };
  ctx.item = it.json;
  ctx.json = it.json;
  ctx.text = it.text;
}

/** The items flowing INTO a node: concat the outputs of every ACTIVE upstream node wired to it
 *  (so merge fans in). Falls back to the seed for an unwired/entry node. studio's inputItemsFor
 *  (`run.ts:285-290`) expressed over Studio's active edges. */
export function inputItemsFor(
  _nodeId: string,
  incomingActive: string[],
  stepItems: Map<string, Item[]>,
  seed: Item[],
): Item[] {
  const collected: Item[] = [];
  for (const src of incomingActive) {
    const it = stepItems.get(src);
    if (it) collected.push(...it);
  }
  return collected.length ? collected : seed;
}

/** True when a graph contains any browser-requiring item node (→ delegate to the flow container). */
export function needsBrowser(graph: { nodes: { type: string; config?: Record<string, unknown> }[] }): boolean {
  return (graph.nodes ?? []).some(
    (n) => n.type === "item" && FLOW_BROWSER_KINDS.has(String(n.config?.kind ?? "")),
  );
}

/** True for any loopback / private / link-local / unique-local / cloud-metadata address (v4 or v6).
 *  Used both on the literal hostname (when it's an IP) and on every DNS-resolved address, so a name
 *  that resolves into a private range (DNS-rebinding) is caught too. */
export function isPrivateAddr(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  // IPv4 (incl. IPv4-mapped IPv6 like ::ffff:127.0.0.1)
  const v4 = h.startsWith("::ffff:") ? h.slice(7) : h;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) {
    const o = v4.split(".").map(Number);
    return (
      o[0] === 0 || o[0] === 127 || o[0] === 10 ||
      (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||
      (o[0] === 192 && o[1] === 168) ||
      (o[0] === 169 && o[1] === 254) || // link-local incl. metadata 169.254.169.254
      (o[0] === 100 && o[1] >= 64 && o[1] <= 127) || // CGNAT 100.64/10
      o[0] >= 224 // multicast / reserved
    );
  }
  // IPv6
  if (h.includes(":")) {
    return (
      h === "::1" || h === "::" ||
      h.startsWith("fc") || h.startsWith("fd") || // unique-local fc00::/7
      h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb") // link-local fe80::/10
    );
  }
  return false;
}

/** SSRF floor (port of studio's `assertPublicUrl`, run.ts:20-39): http/https only, no bare hostnames,
 *  block loopback/private/link-local/metadata ranges on the LITERAL host. This is the synchronous
 *  first gate; `assertResolvedPublic` adds the DNS-rebinding check (resolved-IP re-validation). */
export function assertPublicUrl(raw: string): void {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("invalid URL"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http/https URLs are allowed");
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  // A bare hostname (no dot, not an IPv6 literal) can't be a real public host → reject.
  if (!h.includes(".") && !h.includes(":")) throw new Error(`blocked internal/private host: ${h}`);
  if (isPrivateAddr(h)) throw new Error(`blocked internal/private host: ${h}`);
}

/** DNS-rebinding guard: resolve the URL's host and reject if ANY resolved address is private —
 *  a public-looking name (e.g. an attacker domain) that maps to 169.254.169.254 / 127.0.0.1 is
 *  caught here, where the literal-host check alone would pass. Async; run right before fetch. The
 *  resolver is injected (Node's dns/promises in the api + container) so flow-core stays dep-free. */
export async function assertResolvedPublic(
  raw: string,
  resolve: (host: string) => Promise<string[]>,
): Promise<void> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("invalid URL"); }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isPrivateAddr(host)) throw new Error(`blocked internal/private host: ${host}`); // literal IP
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return; // already an IP literal, checked above
  let addrs: string[];
  try { addrs = await resolve(host); } catch { throw new Error(`DNS resolution failed for ${host}`); }
  if (!addrs.length) throw new Error(`no addresses for ${host}`);
  for (const a of addrs) if (isPrivateAddr(a)) throw new Error(`blocked host ${host} → private address ${a}`);
}

/** Evaluate a transform/If condition over already-resolved string operands. Port of studio's
 *  `evalCondition` (`run.ts:109-122`). */
export function evalCondition(op: string, left: string, right: string): boolean {
  const l = left ?? "";
  const r = right ?? "";
  switch (op) {
    case "not equals": return l !== r;
    case "contains": return l.includes(r);
    case "greater than": return Number(l) > Number(r);
    case "less than": return Number(l) < Number(r);
    case "is empty": return l.trim() === "";
    case "is not empty": return l.trim() !== "";
    case "equals":
    default: return l === r;
  }
}

/** Race a promise against a timeout — the outer guard around `vm`'s async code (port of studio's
 *  `withTimeout`, `run.ts:76-80`). */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out (${ms / 1000}s)`)), ms)),
  ]);
}

/** Strip common secret token shapes out of a persisted error string (port of studio's `redactSecrets`).
 *  A cheap floor so a `code`-node error never leaks an injected key into the run trace. */
export function redactSecrets(s: string): string {
  return (s ?? "")
    .replace(/\b(sk-ant-|sk-|re_|xoxb-)[A-Za-z0-9_-]+/g, "$1***")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***");
}

/**
 * Execute one deterministic (non-browser) item node: array-in → array-out (+ optional `fired`
 * handle for ifCond). Covers httpRequest/setVar/setFields/filter/merge/aggregate/ifCond/code — the
 * kinds that run identically in-process (api) and in the flow container (runner). Browser/AI kinds
 * are container-only and live in exec.mts, not here.
 *
 * Pure w.r.t. the api's DB/tenant/dry-run layer: the dry-run gate + ActionResult typing stay in the
 * api adapter; error handling is return-based ({ok:false}) so each caller maps failures to its own
 * outer convention (the api returns them, the container throws to record an error node event).
 */
export async function runItemNode(
  kind: string,
  config: Record<string, unknown>,
  inputs: Item[],
  ctx: Record<string, unknown>,
  hooks?: RunItemHooks,
): Promise<RunItemNodeResult> {
  switch (kind) {
    case "httpRequest": {
      try {
        let url = interpolate(String(config.url ?? ""), ctx).trim();
        if (!url) return { items: inputs, result: { type: "httpRequest", ok: false, detail: "no URL set" } };
        const method = String(config.method ?? "GET").toUpperCase();
        const headers: Record<string, string> = {};
        const rawHeaders = interpolate(String(config.headers ?? ""), ctx).trim();
        if (rawHeaders) {
          try { Object.assign(headers, JSON.parse(rawHeaders)); }
          catch { return { items: inputs, result: { type: "httpRequest", ok: false, detail: "Headers must be valid JSON" } }; }
        }
        const hasBody = method !== "GET" && method !== "HEAD" && method !== "DELETE" && String(config.body ?? "").trim() !== "";
        if (hasBody && !("content-type" in headers) && !("Content-Type" in headers)) headers["content-type"] = "application/json";
        await hooks?.bumpUsage?.("http");
        // Manual redirect loop: a 30x Location can point back at an internal host, so re-run the FULL
        // guard set (literal SSRF → DNS-rebind → per-tenant egress) on EVERY hop, capped at 3.
        let res: Response;
        let hops = 0;
        for (;;) {
          assertPublicUrl(url);
          if (hooks?.resolveHost) await assertResolvedPublic(url, hooks.resolveHost);
          if (hooks?.assertEgress) await hooks.assertEgress(url);
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), 20_000);
          try {
            res = await fetch(url, {
              method,
              headers,
              body: hasBody ? interpolate(String(config.body ?? ""), ctx) : undefined,
              redirect: "manual",
              signal: ac.signal,
            });
          } finally {
            clearTimeout(timer);
          }
          const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
          if (!loc) break;
          if (++hops > 3) throw new Error("too many redirects");
          url = new URL(loc, url).toString();
        }
        const respText = (await res.text()).slice(0, 2000);
        const vars = (ctx.vars as Record<string, unknown>) ?? {};
        vars.http_status = String(res.status);
        vars.http_body = respText;
        const name = String(config.saveAs ?? "").trim();
        if (name) vars[name] = respText;
        ctx.vars = vars;
        // Emit shape: response body under json.body (NOT json), so downstream reads {{json.body.…}}.
        return {
          items: [{ json: { status: res.status, body: tryJson(respText) }, text: respText }],
          result: { type: "httpRequest", ok: res.ok, detail: `${res.status} ${url}` },
        };
      } catch (e) {
        return { items: inputs, result: { type: "httpRequest", ok: false, detail: redactSecrets(`http failed: ${(e as Error).message}`) } };
      }
    }
    case "setVar": {
      // Write a run-scoped variable (read anywhere as {{vars.name}}). Value resolves against the
      // ambient item (ctx hydrated to inputs[0] by the walk). Port of `run.ts:546-550`.
      const name = String(config.name ?? "").trim();
      const value = interpolate(String(config.value ?? ""), ctx);
      const vars = (ctx.vars as Record<string, unknown>) ?? {};
      if (name) vars[name] = value;
      ctx.vars = vars;
      return {
        items: name ? [{ json: { [name]: value }, text: value }] : inputs,
        result: { type: "setVar", ok: true, detail: `${name || "(unnamed)"} = ${value.slice(0, 50)}` },
      };
    }
    case "setFields": {
      // Build/merge a JSON object per input item; templates resolve per-item. Port of `run.ts:599-619`.
      let fieldSpec: Record<string, unknown>;
      try {
        const parsed = JSON.parse(String(config.fields ?? "{}"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        fieldSpec = parsed as Record<string, unknown>;
      } catch {
        return { items: inputs, result: { type: "setFields", ok: false, detail: "Fields must be a JSON object" } };
      }
      const base = inputs.length ? inputs : [{ json: {}, text: "" }];
      const replace = String(config.mode ?? "") === "replace";
      const items = base.map((it) => {
        // Resolve each templated field against THIS item (hydrate ctx per-item, then interpolate —
        // so studio {{json.x}}/{{text}} and Studio {{vars.x}}/{{subject}} both resolve).
        hydrateCtxItem(ctx, it);
        const setvals: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(fieldSpec)) setvals[k] = typeof v === "string" ? interpolate(v, ctx) : v;
        const prev = it.json && typeof it.json === "object" ? (it.json as Record<string, unknown>) : {};
        const json = replace ? setvals : { ...prev, ...setvals };
        const firstStr = Object.values(setvals).find((x) => typeof x === "string");
        return { json, text: typeof firstStr === "string" ? firstStr : safeStringify(json) };
      });
      hydrateCtxItem(ctx, inputs[0]); // restore the ambient item
      return {
        items,
        result: { type: "setFields", ok: true, detail: `set ${Object.keys(fieldSpec).length} field(s) on ${items.length} item(s)` },
      };
    }
    case "filter": {
      // Keep only the input items matching a condition. Port of `run.ts:621-627`.
      const field = String(config.field ?? "text");
      const op = String(config.op ?? "is not empty");
      const val = interpolate(String(config.value ?? ""), ctx);
      const items = inputs.filter((it) => evalCondition(op, itemValue(it, field), val));
      return {
        items,
        result: { type: "filter", ok: true, detail: `kept ${items.length} of ${inputs.length} item(s)` },
      };
    }
    case "merge": {
      // Fan-in: pass through every item from the active upstream nodes (inputItemsFor already
      // concatenated them). Port of `run.ts:629-633`.
      return {
        items: inputs,
        result: { type: "merge", ok: true, detail: `merged ${inputs.length} item(s)` },
      };
    }
    case "aggregate": {
      // Reduce the input array to a single item. Port of `run.ts:635-655`.
      const op = String(config.op ?? "count");
      const field = String(config.field ?? "text");
      if (op === "concatenate") {
        const sep = String(config.separator ?? "\\n").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
        const joined = inputs.map((it) => it.text ?? "").join(sep);
        return {
          items: [{ json: { text: joined, count: inputs.length }, text: joined }],
          result: { type: "aggregate", ok: true, detail: `joined ${inputs.length} item(s)` },
        };
      }
      if (op === "collect") {
        const values = inputs.map((it) => itemValue(it, field));
        return {
          items: [{ json: { values }, text: JSON.stringify(values) }],
          result: { type: "aggregate", ok: true, detail: `collected ${values.length} value(s)` },
        };
      }
      if (op === "sum") {
        const sum = inputs.reduce((acc, it) => acc + (Number(itemValue(it, field)) || 0), 0);
        return {
          items: [{ json: { sum }, text: String(sum) }],
          result: { type: "aggregate", ok: true, detail: `sum = ${sum}` },
        };
      }
      return {
        items: [{ json: { count: inputs.length }, text: String(inputs.length) }],
        result: { type: "aggregate", ok: true, detail: `count = ${inputs.length}` },
      };
    }
    case "ifCond": {
      // Branch: evaluate a condition over resolved operands and return the fired handle. The walk
      // activates only the out-edge matching `fired` (§6). Items pass through unchanged so the
      // matched branch keeps operating on the real data-plane. Port of `run.ts:573-579`.
      const op = String(config.op ?? "equals");
      const left = interpolate(String(config.left ?? ""), ctx);
      const right = interpolate(String(config.right ?? ""), ctx);
      const ok = evalCondition(op, left, right);
      return {
        items: inputs,
        result: { type: "ifCond", ok: true, detail: `${left || "∅"} ${op} ${right || "∅"} → ${ok}` },
        fired: ok ? "true" : "false",
      };
    }
    case "code": {
      // Run a JS snippet over `items`/`vars` in a node `vm` context. 5s inner (sync) + 8s outer
      // (async) timeout — dev/stage acceptable; §8 moves this to a container before prod. Port of
      // `run.ts:581-597`. `vm` is NOT a security boundary.
      try {
        const src = String(config.code ?? "");
        const logs: string[] = [];
        const capture = (...a: unknown[]) => logs.push(a.map((x) => (typeof x === "string" ? x : safeStringify(x))).join(" "));
        const vars = (ctx.vars as Record<string, unknown>) ?? {};
        ctx.vars = vars;
        const sandbox: Record<string, unknown> = {
          items: inputs, vars, JSON, Math, Date, console: { log: capture, error: capture },
        };
        const vmCtx = vm.createContext(sandbox);
        const out = await withTimeout(
          Promise.resolve(vm.runInContext(`(async function(){\n${src}\n})()`, vmCtx, { timeout: 5000 })),
          8000,
          "code",
        );
        const arr = Array.isArray(out) ? out : out === undefined ? [] : [out];
        const items = arr.map((v) => ({ json: v, text: typeof v === "string" ? v : safeStringify(v) }));
        const detail = `${items.length} item(s)` + (logs.length ? ` · ${logs.join(" | ").slice(0, 200)}` : "");
        return { items, result: { type: "code", ok: true, detail } };
      } catch (e) {
        return { items: inputs, result: { type: "code", ok: false, detail: `code failed: ${redactSecrets((e as Error).message)}` } };
      }
    }
    default:
      // Browser/AI kinds are handled by the caller (container-only) — an unknown kind here passes
      // the data-plane through so the walk doesn't break.
      return {
        items: inputs,
        result: { type: kind || "item", ok: false, detail: `item node not implemented here: ${kind}` },
      };
  }
}
