import { withTenant } from "@repo/db";
import type { AutomationCondition, AutomationConditions } from "@repo/contracts";

// ── Context, interpolation & condition evaluation ─────────────────────────────
// The read-only half of the engine: hydrate an evaluation context from a seed + the live ticket,
// interpolate {{field}} templates, and evaluate a rule's all/any condition AST against it. Pure +
// network-free except buildContext's single ticket read (RLS-scoped via withTenant).

export type Ctx = Record<string, unknown> & { ticketId?: string };

/** Resolve a possibly-dotted path in the context — a flat field (`subject`) or a nested step
 *  output (`steps.<nodeId>.<field>`) for graph data-passing. */
function resolvePath(ctx: Ctx, path: string): unknown {
  if (path in ctx) return ctx[path];
  return path.split(".").reduce<unknown>(
    (o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]),
    ctx as unknown,
  );
}

/** Interpolate {{field}} / {{steps.<id>.<field>}} tokens from the context into a template. */
export function interpolate(tpl: string, ctx: Ctx): string {
  return tpl.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, k: string) => {
    const v = resolvePath(ctx, k);
    return v == null ? "" : String(v);
  });
}

/** Parse the `http` action's newline-separated `Key: Value` header block into a headers object,
 *  interpolating each line against the context. Blank / colon-less lines are skipped. Pure +
 *  network-free (unit-tested). */
export function parseHeaders(raw: string, ctx: Ctx): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (raw ?? "").split("\n")) {
    const l = interpolate(line, ctx);
    const idx = l.indexOf(":");
    if (idx < 0) continue;
    const key = l.slice(0, idx).trim();
    const val = l.slice(idx + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

/** Split a condition value into a lowercased comma-separated list (for `contains_any` / `in`). */
function valueList(v: string): string[] {
  return v.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
}

function evalOne(cond: AutomationCondition, ctx: Ctx): boolean {
  const raw = ctx[cond.field];
  const v = (cond.value ?? "").toLowerCase();

  // Array-valued field (e.g. tags): compare set-wise so tag rules are expressible. `contains` /
  // `contains_any` test membership; `in` is set overlap; empty/non-empty test the array length.
  if (Array.isArray(raw)) {
    const arr = raw.map((x) => String(x).toLowerCase());
    const wants = valueList(v);
    switch (cond.op) {
      case "contains": return v.length === 0 ? true : arr.includes(v);
      case "not_contains": return v.length === 0 ? true : !arr.includes(v);
      case "contains_any": return wants.length === 0 ? true : wants.some((w) => arr.includes(w));
      case "in": return wants.length === 0 ? false : arr.some((a) => wants.includes(a));
      case "equals": return arr.length === 1 && arr[0] === v;
      case "not_equals": return !(arr.length === 1 && arr[0] === v);
      case "is_empty": return arr.length === 0;
      case "is_not_empty": return arr.length > 0;
      default: return false;
    }
  }

  const s = (raw == null ? "" : String(raw)).toLowerCase();
  switch (cond.op) {
    case "equals": return s === v;
    case "not_equals": return s !== v;
    case "contains": return v.length === 0 ? true : s.includes(v);
    case "not_contains": return v.length === 0 ? true : !s.includes(v);
    case "contains_any": { const w = valueList(v); return w.length === 0 ? true : w.some((x) => s.includes(x)); }
    case "in": { const w = valueList(v); return w.includes(s); }
    case "starts_with": return s.startsWith(v);
    case "gt": return Number(s) > Number(v);
    case "lt": return Number(s) < Number(v);
    case "is_empty": return s.length === 0;
    case "is_not_empty": return s.length > 0;
    default: return false;
  }
}

/** True when the context satisfies the rule's all/any condition set. An empty condition list
 *  matches everything (an unconditional rule). Exported for the dry-run + seam tests. */
export function evaluateConditions(conditions: AutomationConditions | undefined, ctx: Ctx): boolean {
  const list = Array.isArray(conditions?.conditions) ? conditions!.conditions : [];
  if (list.length === 0) return true;
  const match = conditions?.match === "any" ? "any" : "all";
  const results = list.map((cond) => evalOne(cond, ctx));
  return match === "any" ? results.some(Boolean) : results.every(Boolean);
}

// Build the full evaluation context: the caller's seed (body/authorType/channelType from ingest,
// etc.) enriched with the live ticket fields the conditions can target.
export async function buildContext(tenantId: string, trigger: string, seed: Ctx): Promise<Ctx> {
  const ctx: Ctx = { event: trigger, ...seed };
  if (seed.ticketId) {
    const t = await withTenant(tenantId, async (c) => {
      const r = await c.query(
        `SELECT subject, status, channel_type, external_channel_id, assignee_id, whose_turn, support_mode, priority, tags,
                (SELECT body FROM messages WHERE ticket_id = $1 AND author_type = 'customer' ORDER BY created_at DESC LIMIT 1) AS latest_body
         FROM tickets WHERE id = $1`,
        [seed.ticketId],
      );
      return r.rowCount ? (r.rows[0] as Record<string, unknown>) : null;
    });
    if (t) {
      ctx.subject = ctx.subject ?? t.subject;
      ctx.status = t.status;
      ctx.channelType = ctx.channelType ?? t.channel_type;
      ctx.externalChannelId = t.external_channel_id;
      ctx.assigneeId = t.assignee_id;
      ctx.whoseTurn = t.whose_turn;
      ctx.supportMode = t.support_mode ?? "staffed";
      // Dogfood L1 (C1): hydrate priority + tags so routing/tagging rules can target them.
      // priority is a scalar; tags is a string[] (evalOne compares arrays set-wise).
      ctx.priority = ctx.priority ?? t.priority ?? "normal";
      ctx.tags = (t.tags as string[]) ?? [];
      // The agent/branch needs the customer's actual words; hydrate the latest inbound message as
      // ctx.body when the trigger event didn't already carry one (e.g. a manual Studio run).
      if (!ctx.body && t.latest_body) ctx.body = t.latest_body as string;
    }
  }
  return ctx;
}
