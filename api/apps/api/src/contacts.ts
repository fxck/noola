import { withTenant } from "@repo/db";
import type { PoolClient } from "pg";
import type { ContactFilterCondition, ContactSortField } from "@repo/contracts";
import { countryCentroid, jitterFromId } from "./country-centroids.js";
import { versionStatusSql } from "./tech-status.js";

// The contacts directory + back-office sync. A tenant-scoped people/company directory
// with free-form attributes (RLS-isolated), an idempotent upsert (on the caller's stable
// external_id, else on a case-insensitive email), a bulk importer, and per-contact ticket
// history. Every function funnels through withTenant so tenant isolation is enforced in
// exactly one place. Outbound webhooks on create/upsert are a later slice — createContact
// and upsertContact are the single choke points to hook when it lands.

export interface ContactRow {
  id: string;
  external_id: string | null;
  email: string | null;
  name: string;
  company: string;
  company_id: string | null;
  attributes: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  avatar_url: string | null;
  unsubscribed_at: string | null; // marketing opt-out (0065); null = subscribed
  /** Who opted out (0120): 'api' | 'contact' | 'agent' | 'import'; null while subscribed (or legacy). */
  unsubscribed_source: UnsubscribeSource | null;
  /** Free-form labels (0123), e.g. the event a person was imported from. Sorted, deduped. */
  tags: string[];
  /** Derived (list/get only): a human-recognizable contact (has a name or an email). False =
   *  anonymous — e.g. a widget visitor keyed only by conversation id. Not a stored column. */
  identified?: boolean;
  /** Derived (list/get only): the contact's first channel identity (widget/email/discord/…),
   *  so anonymous rows can render "Widget visitor" instead of a bare "Unnamed". */
  primary_channel?: string | null;
  /** Last widget touch (ask / poll / identify / track), bumped throttled. */
  last_seen_at?: string | null;
  /** Derived (list/get only): last_seen_at within the online window (3 min). */
  online?: boolean;
  /** Derived (list/get only): the contact's company memberships (0111 junction), primary first.
   *  The primary mirrors the legacy company_id/company columns; the rest are extra accounts. */
  companies?: ContactCompany[];
  /** Derived (list/get only, 0121): see contactAccountStatusSql. */
  account_status?: ContactAccountStatus;
}

/** customer = synced member of a live synced company; user = synced person with no live company;
 *  former = was synced (person or company membership) but removed in the system of record;
 *  lead = never synced (widget visitor, CSV/conference contact, email sender). */
export type ContactAccountStatus = "customer" | "user" | "former" | "lead";

/** SQL for a contact's account_status, correlated on the unaliased `contacts` table (every filter
 *  consumer — directory, segment preview, broadcast resolution — selects FROM contacts). Only a
 *  SYNC-owned membership makes a customer: an agent linking a lead to a synced company by hand
 *  doesn't. */
export const CONTACT_ACCOUNT_STATUS_SQL = `(CASE
  WHEN EXISTS (SELECT 1 FROM contact_companies acc JOIN companies aco ON aco.tenant_id = acc.tenant_id AND aco.id = acc.company_id
                WHERE acc.contact_id = contacts.id AND acc.source = 'sync'
                  AND aco.synced_at IS NOT NULL AND aco.sync_removed_at IS NULL) THEN 'customer'
  WHEN contacts.synced_at IS NOT NULL AND contacts.sync_removed_at IS NULL THEN 'user'
  WHEN contacts.synced_at IS NOT NULL OR EXISTS (SELECT 1 FROM contact_companies acc WHERE acc.contact_id = contacts.id AND acc.source = 'sync') THEN 'former'
  ELSE 'lead' END)`;

/** One company a contact belongs to (0111 many-to-many). `is_primary` marks the account that
 *  keeps the denormalized contacts.company_id / contacts.company columns in sync. */
export interface ContactCompany {
  id: string;
  name: string;
  is_primary: boolean;
  role?: string;
  /** 'sync' = owned by the account sync (replaced on every members sync); 'manual' otherwise. */
  source?: string;
}

/** A partial patch for a contact — the fields a caller may set. Undefined = leave alone;
 *  null on the two nullable columns (external_id / email) = clear the stored value. */
export interface ContactInputShape {
  external_id?: string | null;
  email?: string | null;
  name?: string;
  company?: string;
  /** Your external id for the contact's company (Intercom company `company_id`) — when present it is
   *  the dedup key for resolving the company (external_id first, then the `company` name). */
  company_external_id?: string | null;
  company_id?: string | null;
  /** Many-to-many company membership (0111). ORDERED — first = primary. When defined it REPLACES
   *  the contact's full company set (overriding company/company_id, which are derived from the
   *  primary); [] clears all. Left undefined = leave memberships untouched. */
  company_ids?: string[];
  attributes?: Record<string, unknown>;
  /** Replaces the contact's tag set (updateContact). Normalized via normalizeTags. */
  tags?: string[];
  /** Semantic fields the CSV importer maps onto real columns (Intercom parity). All optional;
   *  written by upsertOne only, and only when provided (COALESCE keeps the stored value otherwise). */
  avatar_url?: string | null;
  unsubscribed_at?: string | null;
  last_seen_at?: string | null;
  /** "Customer since" — from Intercom's Signed up / First Seen. Backfills the real created_at. */
  created_at?: string | null;
}

export interface ListFilters {
  q?: string; // matches name / email / company (ILIKE)
  company?: string; // exact company match
  attrKey?: string; // attributes ->> key ...
  attrValue?: string; // ... = value (when attrKey also given); attrKey alone = key exists
  conditions?: ContactFilterCondition[]; // the filter-builder conditions (AND-combined)
  // OR groups: each inner array is AND-combined, the groups OR together —
  // ((g1c1 AND g1c2) OR (g2c1 …)). AND-combined with everything above.
  conditionGroups?: ContactFilterCondition[][];
  /** identified = has a name or email; anonymous = neither (widget visitors etc.). */
  identity?: "identified" | "anonymous";
  sort?: { by: ContactSortField; dir: "asc" | "desc" };
  limit?: number;
  offset?: number;
}

const COLS =
  "id, external_id, email, name, company, company_id, attributes, created_at, updated_at, avatar_url, unsubscribed_at, unsubscribed_source, tags";

export type UnsubscribeSource = "api" | "contact" | "agent" | "import";

/** SQL for `unsubscribed_source` in an UPDATE that opts a contact out (0120), with `param` the
 *  placeholder holding the new source. The FIRST opt-out's source sticks — except an 'api' one,
 *  which any later opt-out upgrades — so a person's own opt-out is never relabeled 'api' (which
 *  would let the public API re-subscribe them without `force`). Must be evaluated in the same SET
 *  as the unsubscribed_at write: it reads the pre-update unsubscribed_at. */
export function optOutSourceSql(param: string): string {
  return `CASE WHEN unsubscribed_at IS NULL OR unsubscribed_source = 'api' THEN ${param} ELSE unsubscribed_source END`;
}

// Read-side derived columns (list/get): identity status, first channel identity, presence.
// "Identified" = human-recognizable (name or email); everything else renders as an anonymous
// visitor. "online" derives from last_seen_at so the polling widget counts without WS hooks.
const DERIVED_COLS = `${COLS}, last_seen_at,
  (coalesce(name,'') <> '' OR coalesce(email,'') <> '') AS identified,
  (SELECT ci.channel_type FROM contact_identities ci WHERE ci.contact_id = contacts.id
    ORDER BY ci.created_at ASC LIMIT 1) AS primary_channel,
  (last_seen_at IS NOT NULL AND last_seen_at > now() - interval '3 minutes') AS online,
  COALESCE((
    SELECT json_agg(json_build_object('id', co.id, 'name', co.name, 'is_primary', cc.is_primary,
                                      'role', cc.role, 'source', cc.source)
             ORDER BY cc.is_primary DESC, co.name ASC)
      FROM contact_companies cc
      JOIN companies co ON co.tenant_id = cc.tenant_id AND co.id = cc.company_id
     WHERE cc.contact_id = contacts.id
  ), '[]'::json) AS companies,
  ${CONTACT_ACCOUNT_STATUS_SQL} AS account_status`;

// Whitelisted sortable/filterable core columns → safe SQL identifiers. Field names can't be
// parameterized, so ONLY these literal identifiers ever reach the query; anything else is an
// attribute lookup (attributes ->> $key, key bound as a param) or ignored.
const CORE_COL: Record<string, string> = {
  name: "name",
  email: "email",
  company: "company",
  created_at: "created_at",
  updated_at: "updated_at",
  last_seen_at: "last_seen_at",
  unsubscribed_at: "unsubscribed_at",
};
const DATE_FIELDS = new Set(["created_at", "updated_at", "unsubscribed_at"]);

/** Compile one filter-builder condition into a SQL clause, binding params positionally into
 *  the shared params array. Unknown fields / incomplete value-ops are skipped (the schema
 *  validates shape upstream; this is the last-line safety). Attribute keys are always bound
 *  as params — never interpolated — so free-form keys can't inject. */
/** Per-group context: `company_role is X` conditions in the same AND group, folded into every
 *  account condition (tech / spend / project count) so they're evaluated on the SAME membership —
 *  "owners of clients running PostgreSQL 13", not "an owner of anything who is in some client
 *  running PostgreSQL 13". */
interface ConditionCtx {
  roles?: string[];
}

function rolesOf(conds: ContactFilterCondition[] | undefined): string[] {
  return (conds ?? []).filter((c) => c.field === "company_role" && c.op === "is" && c.value).map((c) => c.value as string);
}

const VERSION_RE = /^[0-9]+(\.[0-9]+)*$/;

/** A contact's LIVE account memberships: sync-owned links to synced, not-removed companies
 *  (aliases acc_m / acc_co). `rolesParam` restricts to the group's roles. */
function membershipFrom(rolesParam: string | null): string {
  return `contact_companies acc_m
      JOIN companies acc_co ON acc_co.tenant_id = acc_m.tenant_id AND acc_co.id = acc_m.company_id
     WHERE acc_m.contact_id = contacts.id AND acc_m.source = 'sync'
       AND acc_co.synced_at IS NOT NULL AND acc_co.sync_removed_at IS NULL
       ${rolesParam ? `AND lower(acc_m.role) = ANY(${rolesParam}::text[])` : ""}`;
}

/** Account conditions (0121): technology usage/version, EOL usage, role, client spend, project
 *  count — all over the contact's live memberships. Returns true when `field` was one of them. */
function compileAccountCondition(
  cond: ContactFilterCondition,
  clauses: string[],
  params: unknown[],
  ctx: ConditionCtx,
): boolean {
  const { field, op } = cond;
  const value = (cond.value ?? "").trim();
  const isAccountField =
    field.startsWith("tech:") || field === "tech_eol" || field === "company_role" ||
    field === "company.avg_monthly_spend" || field === "company.project_count";
  if (!isAccountField) return false;

  const rolesParam = (): string | null => {
    if (!ctx.roles?.length || field === "company_role") return null;
    params.push(ctx.roles.map((r) => r.toLowerCase()));
    return `$${params.length}`;
  };
  const exists = (body: string, negate = false) => clauses.push(`${negate ? "NOT " : ""}EXISTS (SELECT 1 FROM ${body})`);
  const services = (rp: string | null) => `${membershipFrom(rp).replace(/WHERE/, `JOIN company_projects acc_p ON acc_p.tenant_id = acc_co.tenant_id AND acc_p.company_id = acc_co.id
      JOIN project_services acc_s ON acc_s.tenant_id = acc_p.tenant_id AND acc_s.project_id = acc_p.id
     WHERE`)}`;

  if (field.startsWith("tech:")) {
    const tech = field.slice(5).trim().toLowerCase();
    if (!tech) return true;
    const rp = rolesParam();
    params.push(tech);
    const techPred = `acc_s.technology = $${params.length}`;
    if (op === "exists" || op === "not_exists") {
      exists(`${services(rp)} AND ${techPred}`, op === "not_exists");
      return true;
    }
    if (!VERSION_RE.test(value)) return true; // version ops need a numeric version
    if (op === "is" || op === "is_not") {
      params.push(value);
      const v = `$${params.length}`;
      // "16" matches 16 and 16.x (a major pins its minors); "8.4" matches 8.4 and 8.4.x.
      exists(`${services(rp)} AND ${techPred} AND (acc_s.version = ${v} OR acc_s.version LIKE ${v} || '.%')`, op === "is_not");
    } else if (op === "lt" || op === "gt") {
      params.push(value.split(".").map(Number));
      const v = `$${params.length}::int[]`;
      exists(`${services(rp)} AND ${techPred} AND acc_s.version ~ '^[0-9]+(\\.[0-9]+)*$'
                AND string_to_array(acc_s.version, '.')::int[] ${op === "lt" ? "<" : ">"} ${v}`);
    }
    return true;
  }

  if (field === "tech_eol") {
    if (op !== "exists" && op !== "not_exists") return true;
    const rp = rolesParam();
    // Same lifecycle resolution as the Technologies overview (tech-status.ts): with the Zerops
    // catalog, a version the schemas no longer offer counts as EOL.
    exists(`${services(rp)} AND ${versionStatusSql("acc_s")} = 'eol'`, op === "not_exists");
    return true;
  }

  if (field === "company_role") {
    if (op === "exists" || op === "not_exists") {
      exists(`${membershipFrom(null)} AND acc_m.role <> ''`, op === "not_exists");
    } else if ((op === "is" || op === "is_not") && value) {
      params.push(value);
      exists(`${membershipFrom(null)} AND lower(acc_m.role) = lower($${params.length})`, op === "is_not");
    }
    return true;
  }

  // Numeric account fields: any live membership whose company satisfies it.
  if (!/^-?[0-9]+(\.[0-9]+)?$/.test(value)) return true;
  const cmp = op === "lt" ? "<" : op === "gt" ? ">" : op === "is" ? "=" : op === "is_not" ? "<>" : null;
  if (!cmp) return true;
  const rp = rolesParam();
  params.push(value);
  const v = `$${params.length}`;
  const expr = field === "company.avg_monthly_spend"
    ? `acc_co.avg_monthly_spend ${cmp} ${v}::numeric`
    : `(SELECT count(*) FROM company_projects acc_pc WHERE acc_pc.company_id = acc_co.id) ${cmp} ${v}::int`;
  exists(`${membershipFrom(rp)} AND ${expr}`);
  return true;
}

function compileCondition(cond: ContactFilterCondition, clauses: string[], params: unknown[], ctx: ConditionCtx = {}): void {
  if (compileAccountCondition(cond, clauses, params, ctx)) return;
  const { field, op } = cond;
  const value = cond.value;
  const needsValue =
    op === "is" ||
    op === "is_not" ||
    op === "contains" ||
    op === "not_contains" ||
    op === "starts_with" ||
    op === "ends_with" ||
    op === "before" ||
    op === "after";
  if (needsValue && (value === undefined || value === "")) return; // incomplete → ignore

  // Escape LIKE metacharacters so a literal % / _ in the value matches literally (the
  // pattern ops below wrap the escaped value in their own wildcards).
  const likeLiteral = (v: string): string => v.replace(/[\\%_]/g, "\\$&");

  const valueClause = (colExpr: string): void => {
    if (op === "is") {
      params.push(value);
      clauses.push(`${colExpr} = $${params.length}`);
    } else if (op === "is_not") {
      params.push(value);
      clauses.push(`${colExpr} IS DISTINCT FROM $${params.length}`);
    } else if (op === "contains") {
      params.push(`%${likeLiteral(String(value))}%`);
      clauses.push(`${colExpr} ILIKE $${params.length}`);
    } else if (op === "not_contains") {
      // NULL-safe negation: a null column should NOT match "does not contain".
      params.push(`%${likeLiteral(String(value))}%`);
      clauses.push(`(${colExpr} IS NULL OR ${colExpr} NOT ILIKE $${params.length})`);
    } else if (op === "starts_with") {
      params.push(`${likeLiteral(String(value))}%`);
      clauses.push(`${colExpr} ILIKE $${params.length}`);
    } else if (op === "ends_with") {
      params.push(`%${likeLiteral(String(value))}`);
      clauses.push(`${colExpr} ILIKE $${params.length}`);
    }
  };

  // Event conditions: `event:<name>` targets the contact_events timeline. exists/not_exists
  // = "has (n)ever done it"; after/before = "did it since/until <date>". Correlated on the
  // qualified contacts columns so it compiles inside every consumer (directory listing,
  // preview counts, broadcast resolution subqueries — all FROM contacts).
  if (field.startsWith("event:")) {
    const name = field.slice(6).trim();
    if (!name) return;
    params.push(name);
    const namePos = `$${params.length}`;
    const base = `SELECT 1 FROM contact_events ce WHERE ce.tenant_id = contacts.tenant_id AND ce.contact_id = contacts.id AND ce.name = ${namePos}`;
    if (op === "exists") {
      clauses.push(`EXISTS (${base})`);
      return;
    }
    if (op === "not_exists") {
      clauses.push(`NOT EXISTS (${base})`);
      return;
    }
    if (op === "after" || op === "before") {
      if (value === undefined || value === "") return;
      params.push(value);
      clauses.push(`EXISTS (${base} AND ce.created_at ${op === "after" ? ">" : "<"} $${params.length}::timestamptz)`);
      return;
    }
    return; // value ops don't apply to events
  }

  if (field.startsWith("attr:")) {
    const key = field.slice(5).trim();
    if (!key) return;
    if (op === "exists") {
      params.push(key);
      clauses.push(`attributes ? $${params.length}`);
      return;
    }
    if (op === "not_exists") {
      params.push(key);
      clauses.push(`NOT (attributes ? $${params.length})`);
      return;
    }
    if (op === "before" || op === "after") return; // ordering ops are date-only
    params.push(key);
    valueClause(`attributes ->> $${params.length}`);
    return;
  }

  // Company: match ANY of the contact's companies (the 0111 junction), not only the primary that the
  // denormalized contacts.company column mirrors — a member of several accounts must be reachable by
  // each. The free-text column still counts (a company name with no account record).
  if (field === "company") {
    const names = `(SELECT co.name FROM contact_companies cc JOIN companies co ON co.tenant_id = cc.tenant_id AND co.id = cc.company_id
                     WHERE cc.contact_id = contacts.id
                    UNION ALL SELECT contacts.company WHERE contacts.company <> '') AS m(name)`;
    const any = (pred: string) => `EXISTS (SELECT 1 FROM ${names} WHERE ${pred})`;
    const none = (pred: string) => `NOT EXISTS (SELECT 1 FROM ${names} WHERE ${pred})`;
    if (op === "exists") { clauses.push(any("true")); return; }
    if (op === "not_exists") { clauses.push(none("true")); return; }
    const pattern =
      op === "contains" || op === "not_contains" ? `%${likeLiteral(String(value))}%`
      : op === "starts_with" ? `${likeLiteral(String(value))}%`
      : op === "ends_with" ? `%${likeLiteral(String(value))}`
      : null;
    if (op === "is" || op === "is_not") {
      params.push(value);
      const pred = `m.name = $${params.length}`;
      clauses.push(op === "is" ? any(pred) : none(pred));
    } else if (pattern !== null) {
      params.push(pattern);
      const pred = `m.name ILIKE $${params.length}`;
      clauses.push(op === "not_contains" ? none(pred) : any(pred));
    }
    return;
  }
  // Tags (0123): is / is_not = carries / lacks that exact tag (case-insensitive); contains = any tag
  // containing the text; exists / not_exists = has any tag / none.
  if (field === "tag") {
    if (op === "exists") { clauses.push("cardinality(tags) > 0"); return; }
    if (op === "not_exists") { clauses.push("cardinality(tags) = 0"); return; }
    if (op === "is" || op === "is_not") {
      params.push(String(value).trim());
      clauses.push(`${op === "is_not" ? "NOT " : ""}EXISTS (SELECT 1 FROM unnest(contacts.tags) tg WHERE lower(tg) = lower($${params.length}))`);
    } else if (op === "contains" || op === "not_contains") {
      params.push(`%${likeLiteral(String(value))}%`);
      clauses.push(`${op === "not_contains" ? "NOT " : ""}EXISTS (SELECT 1 FROM unnest(contacts.tags) tg WHERE tg ILIKE $${params.length})`);
    }
    return;
  }
  // Account status (0121): customer / user / former / lead — see CONTACT_ACCOUNT_STATUS_SQL.
  if (field === "account_status") {
    if (op === "is" || op === "is_not") valueClause(CONTACT_ACCOUNT_STATUS_SQL);
    return;
  }

  const col = CORE_COL[field];
  if (!col) return; // not a whitelisted core column
  // exists/not_exists is type-aware: timestamps can't compare against '' (Postgres would
  // reject the cast), and on unsubscribed_at the pair reads as "is unsubscribed / is
  // subscribed" — the filter builder's subscription-state condition.
  if (op === "exists") {
    clauses.push(DATE_FIELDS.has(field) ? `${col} IS NOT NULL` : `(${col} IS NOT NULL AND ${col} <> '')`);
    return;
  }
  if (op === "not_exists") {
    clauses.push(DATE_FIELDS.has(field) ? `${col} IS NULL` : `(${col} IS NULL OR ${col} = '')`);
    return;
  }
  if ((op === "before" || op === "after") && DATE_FIELDS.has(field)) {
    params.push(value);
    clauses.push(`${col} ${op === "before" ? "<" : ">"} $${params.length}::timestamptz`);
    return;
  }
  if (op === "before" || op === "after") return; // ordering ops only valid on date columns
  valueClause(col);
}

/**
 * Build the directory filter as a list of SQL conditions + their positional params.
 * The ONE place the q/company/attrKey/attrValue semantics live — reused by listContacts
 * (the directory) and by broadcast segment resolution (which appends its own clauses).
 * `q` fuzzy-matches name/email/company (ILIKE); `company` is exact; `attrKey`(+`attrValue`)
 * filters the attributes bag (key-exists when value omitted). Returns empty when unfiltered.
 */
export function buildContactWhere(filters: ListFilters = {}): { clauses: string[]; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.q && filters.q.trim()) {
    params.push(`%${filters.q.trim()}%`);
    const p = `$${params.length}`;
    clauses.push(`(name ILIKE ${p} OR email ILIKE ${p} OR company ILIKE ${p})`);
  }
  if (filters.company && filters.company.trim()) {
    compileCondition({ field: "company", op: "is", value: filters.company.trim() }, clauses, params);
  }
  if (filters.attrKey && filters.attrKey.trim()) {
    const key = filters.attrKey.trim();
    if (filters.attrValue !== undefined && filters.attrValue !== "") {
      params.push(key);
      const kp = `$${params.length}`;
      params.push(filters.attrValue);
      const vp = `$${params.length}`;
      clauses.push(`attributes ->> ${kp} = ${vp}`);
    } else {
      params.push(key);
      clauses.push(`attributes ? $${params.length}`);
    }
  }
  // The filter-builder conditions (AND-combined with the simple params above).
  const topCtx: ConditionCtx = { roles: rolesOf(filters.conditions) };
  for (const cond of filters.conditions ?? []) {
    compileCondition(cond, clauses, params, topCtx);
  }
  // OR groups: compile each group into its own clause list, AND within, OR across. A group
  // whose conditions all get skipped disappears; if EVERY group vanishes, so does the OR.
  const groupSqls: string[] = [];
  for (const group of filters.conditionGroups ?? []) {
    const groupClauses: string[] = [];
    // A group's roles fold into its own account conditions (and the top-level roles still apply,
    // the flat conditions AND with every group).
    const groupCtx: ConditionCtx = { roles: [...(topCtx.roles ?? []), ...rolesOf(group)] };
    for (const cond of group) compileCondition(cond, groupClauses, params, groupCtx);
    if (groupClauses.length) groupSqls.push(`(${groupClauses.join(" AND ")})`);
  }
  if (groupSqls.length) clauses.push(`(${groupSqls.join(" OR ")})`);
  return { clauses, params };
}

/** Fire an outbound webhook event, fire-and-forget. Dynamic import keeps webhooks out of
 *  the contacts module graph and matches the ingest⇄autoreply pattern; errors are
 *  swallowed so a webhook never affects the contact write that just committed. */
export function fireWebhook(tenantId: string, event: string, data: unknown): void {
  void import("./webhooks.js")
    .then((m) => m.fireEvent(tenantId, event, data))
    .catch(() => {});
}

/** JSON-encode an attributes bag for a ::jsonb parameter, or null when absent. */
function jsonOrNull(attributes?: Record<string, unknown>): string | null {
  return attributes === undefined ? null : JSON.stringify(attributes);
}

/** Directory listing with filters. `q` fuzzy-matches name/email/company; `company` is an
 *  exact match; `attrKey`(+`attrValue`) filters on the attributes bag. Newest-touched
 *  first. Returns the page plus the total count of all matches (for pagination). */
export async function listContacts(
  tenantId: string,
  filters: ListFilters = {},
): Promise<{ contacts: ContactRow[]; total: number }> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);

  const { clauses, params } = buildContactWhere(filters);
  // Identity cut: identified = has a name or an email; anonymous = neither (widget visitors
  // keyed only by conversation id, unidentified channel users).
  if (filters.identity === "identified") clauses.push("(coalesce(name,'') <> '' OR coalesce(email,'') <> '')");
  else if (filters.identity === "anonymous") clauses.push("(coalesce(name,'') = '' AND coalesce(email,'') = '')");
  // Spam-hidden leads (dropped via "Mark as spam") never surface in the directory; Unspam restores them.
  clauses.push("spam_at IS NULL");
  const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  // Sort column is whitelisted (CORE_COL) so it's a safe identifier; direction is a literal.
  // NULLS LAST keeps empty emails at the bottom either way; id is the stable tiebreaker.
  const sortCol = (filters.sort && CORE_COL[filters.sort.by]) || "updated_at";
  const sortDir = filters.sort?.dir === "asc" ? "ASC" : "DESC";

  return withTenant(tenantId, async (c) => {
    const totalR = await c.query(`SELECT count(*)::int AS n FROM contacts ${whereSql}`, params);
    const total = totalR.rows[0].n as number;
    const pageR = await c.query(
      `SELECT ${DERIVED_COLS} FROM contacts ${whereSql}
        ORDER BY ${sortCol} ${sortDir} NULLS LAST, id ASC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    return { contacts: pageR.rows as ContactRow[], total };
  });
}

export async function getContact(tenantId: string, id: string): Promise<ContactRow | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(`SELECT ${DERIVED_COLS} FROM contacts WHERE id = $1`, [id]);
    return r.rowCount ? (r.rows[0] as ContactRow) : null;
  });
}

/** One plottable contact — a slim projection for the map view (no attributes bag, no ticket
 *  rollups): identity + the IP-derived city-level coordinate enrichment stamped on the contact. */
export interface ContactGeoPoint {
  id: string;
  name: string;
  company: string;
  city: string | null;
  country: string | null;
  avatar_url: string | null;
  lat: number;
  lng: number;
  /** true = coordinates are an approximate country-centroid placement (imported contact with a
   *  Country but no precise IP coordinates), not a precise pin. */
  approx?: boolean;
}

/** Contacts to plot on the map. Precise coordinates (the Latitude/Longitude IP-enrichment attributes)
 *  are used when present; otherwise, for an IMPORTED contact that carries only a Country name (no IP
 *  coordinates — the common case after an Intercom/CSV migration), we fall back to an approximate
 *  country-centroid placement (jittered per contact so a country's people spread into a cluster). A
 *  contact with neither precise coords nor a recognized Country is not placeable and is skipped.
 *  Spam-hidden contacts are excluded, mirroring the directory. The numeric guards keep a malformed
 *  attribute value from failing the ::float8 cast — such a row degrades to the country fallback. */
export async function listContactGeoPoints(tenantId: string): Promise<ContactGeoPoint[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT id, name, company, avatar_url,
              attributes->>'City'    AS city,
              attributes->>'Country' AS country,
              CASE WHEN attributes->>'Latitude'  ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (attributes->>'Latitude')::float8  END AS lat,
              CASE WHEN attributes->>'Longitude' ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (attributes->>'Longitude')::float8 END AS lng
         FROM contacts
        WHERE spam_at IS NULL
          AND ( (attributes->>'Latitude'  ~ '^-?[0-9]+(\\.[0-9]+)?$'
                 AND attributes->>'Longitude' ~ '^-?[0-9]+(\\.[0-9]+)?$')
                OR nullif(btrim(attributes->>'Country'), '') IS NOT NULL )`,
    );
    const out: ContactGeoPoint[] = [];
    for (const row of r.rows as Array<Omit<ContactGeoPoint, "lat" | "lng" | "approx"> & { lat: number | null; lng: number | null }>) {
      if (row.lat != null && row.lng != null) {
        out.push({ ...row, lat: row.lat, lng: row.lng, approx: false });
        continue;
      }
      // No precise coordinates — place at the country centroid if we recognize the country.
      const base = countryCentroid(row.country);
      if (!base) continue;
      const j = jitterFromId(base, row.id);
      out.push({ ...row, lat: j.lat, lng: j.lng, approx: true });
    }
    return out;
  });
}

/** Throttled presence bump — any widget touch (ask / poll / identify / track) marks the contact
 *  seen. The 60s throttle keeps the polling widget from writing on every poll; "online" derives
 *  from this at read time, so no disconnect hook is needed. Fire-and-forget at call sites. */
export async function bumpContactSeen(tenantId: string, contactId: string): Promise<void> {
  await withTenant(tenantId, async (c) => {
    // Presence + session counting in one write (Intercom-parity "Web sessions"): a touch after a
    // 30-min inactivity gap (or the first touch) starts a new session and increments the counter,
    // stored under Intercom's "Web sessions" key so it overwrites the imported snapshot in place.
    // The regexp guard tolerates a non-numeric imported value without aborting the update.
    await c.query(
      `UPDATE contacts
          SET last_seen_at = now(),
              attributes = jsonb_set(
                COALESCE(attributes, '{}'::jsonb),
                '{Web sessions}',
                to_jsonb(
                  COALESCE(NULLIF(regexp_replace(COALESCE(attributes->>'Web sessions', ''), '\\D', '', 'g'), '')::int, 0)
                  + CASE WHEN last_seen_at IS NULL OR last_seen_at < now() - interval '30 minutes' THEN 1 ELSE 0 END
                )
              )
        WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '60 seconds')`,
      [contactId],
    );
  }).catch(() => {}); // presence is best-effort — never fail the request over it
}

// ── Company membership (0111 many-to-many) ───────────────────────────────────
// The contact_companies junction is the source of truth for "which companies a contact belongs
// to"; contacts.company_id / contacts.company stay pinned to the PRIMARY membership so the
// account rollups, directory filters, and company-detail contact lists keep reading them
// unchanged. Both writers below run on a withTenant client (RLS-scoped, current_tenant()).

/**
 * Authoritatively rewrite a contact's full company set. `companyIds` is ORDERED — the first is
 * the primary. Unknown / cross-tenant ids are dropped (RLS scopes the lookup). Passing [] clears
 * every membership. Returns the primary id + its name so the caller can pin the denormalized
 * contacts.company_id / contacts.company columns.
 *
 * The one-primary-per-contact partial unique index (contact_companies_primary_uq) forbids two
 * live primaries even transiently, so we upsert every row as NON-primary first (clearing any
 * stale primary), then promote exactly one — never two rows carry is_primary=true at once.
 */
async function setContactCompanies(
  c: PoolClient,
  contactId: string,
  companyIds: string[],
): Promise<{ primaryId: string | null; primaryName: string }> {
  const ids = [...new Set(companyIds.filter((x): x is string => typeof x === "string" && x.length > 0))];
  const found = ids.length
    ? ((await c.query(`SELECT id, name FROM companies WHERE id = ANY($1::uuid[])`, [ids])).rows as { id: string; name: string }[])
    : [];
  const nameById = new Map(found.map((r) => [r.id, r.name]));
  const validIds = ids.filter((id) => nameById.has(id)); // preserve order, drop unknown/cross-tenant

  // Drop memberships no longer present.
  if (validIds.length) {
    await c.query(`DELETE FROM contact_companies WHERE contact_id = $1 AND NOT (company_id = ANY($2::uuid[]))`, [contactId, validIds]);
  } else {
    await c.query(`DELETE FROM contact_companies WHERE contact_id = $1`, [contactId]);
  }
  // Upsert every membership as non-primary (also demotes a previously-primary row that's staying).
  for (const id of validIds) {
    await c.query(
      `INSERT INTO contact_companies (tenant_id, contact_id, company_id, is_primary)
       VALUES (current_tenant(), $1, $2, false)
       ON CONFLICT (tenant_id, contact_id, company_id) DO UPDATE SET is_primary = false`,
      [contactId, id],
    );
  }
  const primaryId = validIds[0] ?? null;
  if (primaryId) {
    await c.query(`UPDATE contact_companies SET is_primary = true WHERE contact_id = $1 AND company_id = $2`, [contactId, primaryId]);
  }
  return { primaryId, primaryName: primaryId ? (nameById.get(primaryId) ?? "") : "" };
}

/** Mirror a legacy single-company change (import / upsert / merge set contacts.company_id
 *  directly) into the junction so the membership set never drifts from the denormalized column:
 *  demote any current primary, then upsert this company as the primary. Additive — other
 *  memberships are left in place. */
async function ensurePrimaryCompany(c: PoolClient, contactId: string, companyId: string): Promise<void> {
  await c.query(`UPDATE contact_companies SET is_primary = false WHERE contact_id = $1 AND is_primary`, [contactId]);
  await c.query(
    `INSERT INTO contact_companies (tenant_id, contact_id, company_id, is_primary)
     VALUES (current_tenant(), $1, $2, true)
     ON CONFLICT (tenant_id, contact_id, company_id) DO UPDATE SET is_primary = true`,
    [contactId, companyId],
  );
}

/** Plain insert (no conflict handling — use upsertContact for idempotent sync). Throws
 *  a pg 23505 if external_id / email already exists for the tenant. */
export async function createContact(tenantId: string, input: ContactInputShape): Promise<ContactRow> {
  const contact = await withTenant(tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO contacts (tenant_id, external_id, email, name, company, company_id, attributes)
       VALUES (current_tenant(), $1, $2, COALESCE($3,''), COALESCE($4,''), $5, COALESCE($6,'{}'::jsonb))
       RETURNING id`,
      [input.external_id ?? null, input.email ?? null, input.name ?? null, input.company ?? null, input.company_id ?? null, jsonOrNull(input.attributes)],
    );
    const id = r.rows[0].id as string;
    if (input.company_ids !== undefined) {
      // The membership set is authoritative — pin the denormalized columns to the primary.
      const { primaryId, primaryName } = await setContactCompanies(c, id, input.company_ids);
      await c.query(`UPDATE contacts SET company_id = $2, company = $3 WHERE id = $1`, [id, primaryId, primaryName]);
    } else if (input.company_id) {
      // Legacy single-company create → keep the junction consistent.
      await ensurePrimaryCompany(c, id, input.company_id);
    }
    const sel = await c.query(`SELECT ${DERIVED_COLS} FROM contacts WHERE id = $1`, [id]);
    return sel.rows[0] as ContactRow;
  });
  fireWebhook(tenantId, "contact.created", contact);
  return contact;
}

/** Partial update: only the provided fields change; attributes REPLACE (not merge) when
 *  given — a patch that wants the merge semantics goes through upsertContact. Returns null
 *  if the contact is gone. */
export async function updateContact(
  tenantId: string,
  id: string,
  input: ContactInputShape,
): Promise<ContactRow | null> {
  // company_ids (the many-to-many set) is authoritative when present: it drives the primary and
  // the denormalized company/company_id columns, so the legacy scalar path is skipped for those.
  const manageSet = input.company_ids !== undefined;
  const sets: string[] = [];
  const params: unknown[] = [id];
  const set = (col: string, val: unknown): void => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  if (input.external_id !== undefined) set("external_id", input.external_id);
  if (input.email !== undefined) set("email", input.email);
  if (input.name !== undefined) set("name", input.name);
  if (!manageSet && input.company !== undefined) set("company", input.company);
  if (!manageSet && input.company_id !== undefined) set("company_id", input.company_id);
  if (input.attributes !== undefined) {
    params.push(JSON.stringify(input.attributes));
    sets.push(`attributes = $${params.length}::jsonb`);
  }
  if (input.tags !== undefined) {
    params.push(normalizeTags(input.tags));
    sets.push(`tags = $${params.length}::text[]`);
  }

  const contact = await withTenant(tenantId, async (c) => {
    const exists = await c.query(`SELECT 1 FROM contacts WHERE id = $1`, [id]);
    if (!exists.rowCount) return null;

    if (sets.length) {
      sets.push("updated_at = now()");
      await c.query(`UPDATE contacts SET ${sets.join(", ")} WHERE id = $1`, params);
    }

    if (manageSet) {
      const { primaryId, primaryName } = await setContactCompanies(c, id, input.company_ids ?? []);
      await c.query(`UPDATE contacts SET company_id = $2, company = $3, updated_at = now() WHERE id = $1`, [id, primaryId, primaryName]);
    } else if (input.company_id !== undefined) {
      // Legacy single-company change → keep the junction primary in step with the column.
      if (input.company_id) await ensurePrimaryCompany(c, id, input.company_id);
      else await c.query(`DELETE FROM contact_companies WHERE contact_id = $1 AND is_primary`, [id]);
    }

    const sel = await c.query(`SELECT ${DERIVED_COLS} FROM contacts WHERE id = $1`, [id]);
    return sel.rows[0] as ContactRow;
  });
  if (contact) fireWebhook(tenantId, "contact.updated", contact);
  return contact;
}

export async function deleteContact(tenantId: string, id: string): Promise<boolean> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query("DELETE FROM contacts WHERE id = $1", [id]);
    return (r.rowCount ?? 0) > 0;
  });
}

/** Soft-hide (spam=true) or restore (spam=false) a lead — the reversible "drop lead" of Mark-as-spam.
 *  The contact stays in the DB (Unspam restores it); it just leaves the directory. */
export async function setContactSpam(tenantId: string, id: string, spam: boolean): Promise<void> {
  await withTenant(tenantId, async (c) => {
    await c.query(
      `UPDATE contacts SET spam_at = ${spam ? "now()" : "NULL"}, updated_at = now() WHERE id = $1`,
      [id],
    );
  });
}

/** Count a contact's tickets that are NOT spam-hidden. The spam route only drops a lead when this is
 *  zero — never hide a contact who also has real conversations behind the spam one. */
export async function contactLiveTicketCount(tenantId: string, id: string): Promise<number> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query("SELECT count(*)::int AS n FROM tickets WHERE contact_id = $1 AND spam_at IS NULL", [id]);
    return (r.rows[0]?.n as number) ?? 0;
  });
}

export interface UpsertResult {
  contact: ContactRow;
  created: boolean;
}

/**
 * Idempotent upsert — the back-office sync primitive. Conflict key precedence:
 *   1. external_id present → ON CONFLICT (tenant_id, external_id)
 *   2. else email present  → ON CONFLICT (tenant_id, lower(email))
 *   3. else                → plain insert
 * On conflict, provided scalar fields OVERWRITE and attributes SHALLOW-MERGE (jsonb ||,
 * new keys win); unprovided fields keep their stored value. `created` distinguishes an
 * insert from an update via the xmax=0 trick (xmax is 0 only on a fresh row).
 */
export async function upsertContact(tenantId: string, input: ContactInputShape): Promise<UpsertResult> {
  // Delegate to the resolve-then-update primitive (upsertOne) so a single upsert survives the
  // two-unique-key case a bare ON CONFLICT can't express: a NEW external_id/userId arriving with an
  // email ALREADY held by a DIFFERENT contact previously threw an uncaught pg 23505 → 500, breaking
  // the live-enrichment / identify path. Delegating also links company_id + the semantic columns.
  const result = await withTenant(tenantId, async (c) => {
    const { id, created } = await upsertOne(c, input);
    const r = await c.query(`SELECT ${COLS} FROM contacts WHERE id = $1`, [id]);
    return { contact: r.rows[0] as ContactRow, created };
  });
  fireWebhook(tenantId, result.created ? "contact.created" : "contact.updated", result.contact);
  return result;
}

/**
 * Bulk import — upsert every row in ONE tenant-scoped transaction (all-or-nothing).
 * Idempotent per row (same key precedence as upsertContact). Returns how many rows were
 * inserted vs. updated. Cap enforced by the contract (max 1000).
 */
export async function bulkUpsertContacts(
  tenantId: string,
  rows: ContactInputShape[],
): Promise<{ created: number; updated: number }> {
  return withTenant(tenantId, async (c) => {
    let created = 0;
    let updated = 0;
    for (const input of rows) {
      const res = await upsertOne(c, input);
      if (res.created) created++;
      else updated++;
    }
    return { created, updated };
  });
}

/** The single-row upsert body, reused by bulkUpsertContacts so the whole batch shares one
 *  transaction. Returns true if the row was inserted, false if it updated an existing row.
 *
 * A contact has TWO unique identities — external_id and lower(email) — so a single ON CONFLICT
 * (which targets only one constraint) 500s when a row carries a NEW external_id but an email that
 * already belongs to someone (a re-used email across Intercom user_ids, or a contact the widget
 * already created). We instead resolve the existing contact by external_id then email and update
 * it in place; the two handles only move onto the row when the incoming value isn't already held
 * by a DIFFERENT contact, so neither unique constraint can be violated. Net effect: duplicate-email
 * rows collapse onto one contact (the schema's one-contact-per-email invariant), last write wins. */
async function upsertOne(
  c: import("pg").PoolClient,
  input: ContactInputShape,
): Promise<{ id: string; created: boolean }> {
  const ext = input.external_id ?? null;
  const email = input.email ?? null;
  const attrs = jsonOrNull(input.attributes);
  const cid = input.company_id ?? null;
  const avatar = input.avatar_url ?? null;
  const unsub = input.unsubscribed_at ?? null;
  const seen = input.last_seen_at ?? null;
  const created = input.created_at ?? null;

  let id: string | null = null;
  if (ext) {
    const r = await c.query(`SELECT id FROM contacts WHERE external_id = $1 LIMIT 1`, [ext]);
    if (r.rowCount) id = r.rows[0].id as string;
  }
  if (!id && email) {
    const r = await c.query(`SELECT id FROM contacts WHERE email <> '' AND lower(email) = lower($1) LIMIT 1`, [email]);
    if (r.rowCount) id = r.rows[0].id as string;
  }

  if (id) {
    await c.query(
      `UPDATE contacts SET
         name = CASE WHEN $2::text IS NULL THEN name ELSE $2::text END,
         company = CASE WHEN $3::text IS NULL THEN company ELSE $3::text END,
         company_id = COALESCE($4::uuid, company_id),
         attributes = attributes || COALESCE($5::jsonb,'{}'::jsonb),
         avatar_url = COALESCE($6::text, avatar_url),
         unsubscribed_source = CASE WHEN $7::timestamptz IS NULL THEN unsubscribed_source
                                    ELSE ${optOutSourceSql("'import'")} END,
         unsubscribed_at = COALESCE($7::timestamptz, unsubscribed_at),
         last_seen_at = COALESCE($8::timestamptz, last_seen_at),
         email = CASE WHEN $9::text IS NOT NULL AND NOT EXISTS
                   (SELECT 1 FROM contacts x WHERE x.id <> $1 AND x.email <> '' AND lower(x.email) = lower($9::text))
                 THEN $9::text ELSE email END,
         external_id = CASE WHEN external_id IS NULL AND $10::text IS NOT NULL AND NOT EXISTS
                   (SELECT 1 FROM contacts x WHERE x.id <> $1 AND x.external_id = $10::text)
                 THEN $10::text ELSE external_id END,
         created_at = COALESCE($11::timestamptz, created_at),
         updated_at = now()
       WHERE id = $1`,
      [id, input.name ?? null, input.company ?? null, cid, attrs, avatar, unsub, seen, email, ext, created],
    );
    await syncUpsertCompanies(c, id, input, cid);
    return { id, created: false };
  }

  const ins = await c.query(
    `INSERT INTO contacts (tenant_id, external_id, email, name, company, company_id, attributes, avatar_url, unsubscribed_at, unsubscribed_source, last_seen_at, created_at)
     VALUES (current_tenant(), $1, $2, COALESCE($3,''), COALESCE($4,''), $5, COALESCE($6,'{}'::jsonb), $7, $8::timestamptz,
             CASE WHEN $8::timestamptz IS NULL THEN NULL ELSE 'import' END, $9::timestamptz, COALESCE($10::timestamptz, now()))
     RETURNING id`,
    [ext, email, input.name ?? null, input.company ?? null, cid, attrs, avatar, unsub, seen, created],
  );
  const newId = ins.rows[0].id as string;
  await syncUpsertCompanies(c, newId, input, cid);
  return { id: newId, created: true };
}

/** Identify/upsert with only a free-text company NAME (no id): resolve-or-create that company and
 *  MERGE it additively into the junction, on the caller's txn connection. This is the omnichannel
 *  "client/account" case — a person logging in under one client sends {user, company-name}; logging
 *  in under a DIFFERENT client sends a different name. We accumulate every one as a membership instead
 *  of clobbering (the old path wrote only the scalar contacts.company, last-write-wins, so the
 *  Companies/clients list on the person detail rendered empty). The FIRST company observed stays
 *  primary — we only set is_primary when the contact has none yet, so re-logins never flip it and the
 *  one-primary partial-unique index is never violated. Returns the resolved company id. */
async function mergeCompany(
  c: PoolClient,
  contactId: string,
  spec: { externalId?: string | null; name?: string | null },
): Promise<string | null> {
  const externalId = (spec.externalId ?? "").trim();
  const name = (spec.name ?? "").trim();
  if (!externalId && !name) return null;

  let companyId: string;
  if (externalId) {
    // Dedup by external_id FIRST (a rename can't fork the account). On a hit, absorb the latest name.
    const byExt = await c.query(`SELECT id FROM companies WHERE external_id = $1 LIMIT 1`, [externalId]);
    if (byExt.rowCount) {
      companyId = byExt.rows[0].id as string;
      if (name) {
        await c.query(`UPDATE companies SET name = $2, updated_at = now() WHERE id = $1 AND name IS DISTINCT FROM $2`, [companyId, name]);
      }
    } else {
      // No external_id match yet: adopt an existing name-matched company that has no external_id
      // (stamp the id onto it) or create a fresh one. The name falls back to the id when only an id was
      // sent. Resolved explicitly — companies_name_uq only covers id-less companies (0121).
      const adopt = await c.query(
        `UPDATE companies SET external_id = $2, updated_at = now()
          WHERE id = (SELECT id FROM companies WHERE external_id IS NULL AND lower(name) = lower($1) LIMIT 1)
          RETURNING id`,
        [name || externalId, externalId],
      );
      const row = adopt.rowCount
        ? adopt.rows[0]
        : (await c.query(
            `INSERT INTO companies (tenant_id, name, external_id) VALUES (current_tenant(), $1, $2) RETURNING id`,
            [name || externalId, externalId],
          )).rows[0];
      companyId = row.id as string;
    }
  } else {
    // Name-only (legacy widget/identify): resolve-or-create by name.
    const ins = await c.query(
      `INSERT INTO companies (tenant_id, name) VALUES (current_tenant(), $1)
       ON CONFLICT (tenant_id, lower(name)) WHERE external_id IS NULL DO UPDATE SET name = companies.name
       RETURNING id`,
      [name],
    );
    companyId = ins.rows[0].id as string;
  }

  // Additive membership — the first company observed stays primary (re-logins under other clients
  // accumulate rather than clobber); the one-primary partial-unique index is never violated.
  const hasPrimary = ((await c.query(
    `SELECT 1 FROM contact_companies WHERE contact_id = $1 AND is_primary LIMIT 1`,
    [contactId],
  )).rowCount ?? 0) > 0;
  await c.query(
    `INSERT INTO contact_companies (tenant_id, contact_id, company_id, is_primary)
     VALUES (current_tenant(), $1, $2, $3)
     ON CONFLICT (tenant_id, contact_id, company_id) DO NOTHING`,
    [contactId, companyId, !hasPrimary],
  );
  return companyId;
}

/** Keep the junction consistent on the upsert path: an explicit company_ids set is authoritative
 *  (and re-pins the primary column); a single company_id is mirrored as the primary membership;
 *  otherwise a free-text company NAME (the widget/identify case) is merged additively into the
 *  junction so cross-client memberships accumulate instead of overwriting. */
async function syncUpsertCompanies(
  c: PoolClient,
  contactId: string,
  input: ContactInputShape,
  cid: string | null,
): Promise<void> {
  if (input.company_ids !== undefined) {
    const { primaryId, primaryName } = await setContactCompanies(c, contactId, input.company_ids);
    await c.query(`UPDATE contacts SET company_id = $2, company = $3 WHERE id = $1`, [contactId, primaryId, primaryName]);
  } else if (cid) {
    await ensurePrimaryCompany(c, contactId, cid);
  } else if ((input.company ?? "").trim() || (input.company_external_id ?? "").trim()) {
    // Resolve by external_id FIRST, then the company name (the "external_id first, then name" dedup).
    const primaryId = await mergeCompany(c, contactId, { externalId: input.company_external_id, name: input.company });
    // Pin the denormalized primary pointer only when it's still empty — keeps company_id referencing
    // a real account without disturbing an already-chosen primary.
    if (primaryId) {
      await c.query(`UPDATE contacts SET company_id = COALESCE(company_id, $2) WHERE id = $1`, [contactId, primaryId]);
    }
  }
}

// ── Cross-channel identity resolution (omnichannel) ──────────────────────────
// A contact is recognized across channels via contact_identities: (channel_type, external handle) →
// contact. Exact email match is the unifier — an email address is the one handle that means the same
// person everywhere; opaque handles (discord user id, phone, chat id, widget conversation) get their
// own identity row and only merge into an email-keyed contact when that email is later observed.

export interface IdentityInput {
  /** The channel this handle belongs to (email, discord, slack, telegram, whatsapp, widget…). */
  channelType: string;
  /** The sender's stable per-channel handle (email address, discord user id, phone, chat id, convo id). */
  externalId?: string | null;
  /** The sender's email, when the channel knows it — the cross-channel unifier. */
  email?: string | null;
  /** The sender's display name, when known — fills a blank contact name (never overwrites). */
  name?: string | null;
}

export interface ContactIdentityRow {
  id: string;
  channel_type: string;
  external_id: string;
  created_at: string;
}

/** Upsert the (channel, handle) → contact mapping on an existing tenant-scoped client. On a handle
 *  that already maps elsewhere, RE-POINT it (email/latest resolution wins). No-op without a handle. */
async function linkIdentity(c: PoolClient, contactId: string, channelType: string, externalId?: string | null): Promise<void> {
  if (!externalId) return;
  await c.query(
    `INSERT INTO contact_identities (tenant_id, contact_id, channel_type, external_id)
     VALUES (current_tenant(), $1, $2, $3)
     ON CONFLICT (tenant_id, channel_type, lower(external_id))
     DO UPDATE SET contact_id = EXCLUDED.contact_id`,
    [contactId, channelType, externalId],
  );
}

/**
 * Fold an ANONYMOUS shell (no email, no external_id — a widget visitor we only know by a conversation
 * handle) into `keepId`, on the caller's tenant-scoped client so it commits with whatever transaction
 * it is part of. This is the lead -> user conversion: the person who chatted before they told us who
 * they are is the same person, so their conversations, authored messages, activity, channel handles
 * and company memberships move onto the identified contact and the shell is deleted — one record,
 * history intact.
 *
 * Refuses (returns false) when the drop carries an identity of its own. An identified contact is
 * NEVER swallowed automatically — that is a real person's profile and needs the agent-driven
 * mergeContacts, not a conversation handle someone else happens to send us.
 */
export async function absorbAnonymousContact(c: PoolClient, keepId: string, dropId: string): Promise<boolean> {
  if (!keepId || !dropId || keepId === dropId) return false;
  const drop = await c.query(
    `SELECT id FROM contacts WHERE id = $1 AND coalesce(email,'') = '' AND external_id IS NULL`,
    [dropId],
  );
  if (!drop.rowCount) return false;
  // tickets/messages are ON DELETE SET NULL — re-home them BEFORE the delete or the conversation is
  // orphaned (contact_id nulled) instead of carried over.
  await c.query("UPDATE tickets SET contact_id = $1 WHERE contact_id = $2", [keepId, dropId]);
  await c.query("UPDATE messages SET author_contact_id = $1 WHERE author_contact_id = $2", [keepId, dropId]);
  await c.query("UPDATE contact_events SET contact_id = $1 WHERE contact_id = $2", [keepId, dropId]);
  // Handles + memberships move only where the survivor doesn't already hold them; the rest cascade
  // with the shell below (the kept side wins).
  await c.query(
    `UPDATE contact_identities ci SET contact_id = $1
      WHERE ci.contact_id = $2
        AND NOT EXISTS (
          SELECT 1 FROM contact_identities k
           WHERE k.tenant_id = ci.tenant_id AND k.contact_id = $1
             AND k.channel_type = ci.channel_type
             AND lower(k.external_id) = lower(ci.external_id))`,
    [keepId, dropId],
  );
  await c.query(
    `UPDATE contact_companies cc SET contact_id = $1, is_primary = false
      WHERE cc.contact_id = $2
        AND NOT EXISTS (
          SELECT 1 FROM contact_companies k
           WHERE k.tenant_id = cc.tenant_id AND k.contact_id = $1 AND k.company_id = cc.company_id)`,
    [keepId, dropId],
  );
  // Carry what the shell learned and the survivor lacks: display name, the widget's live enrichment
  // (page/browser/geo — the survivor's own values win), avatar, presence, tags, and the EARLIEST
  // created_at, so "known since" dates from the first anonymous visit rather than the signup.
  // Consent is deliberately untouched: an emailless shell can hold no marketing opt-out.
  await c.query(
    `UPDATE contacts k
        SET name = CASE WHEN coalesce(k.name,'') = '' THEN d.name ELSE k.name END,
            company = CASE WHEN coalesce(k.company,'') = '' THEN d.company ELSE k.company END,
            company_id = COALESCE(k.company_id, d.company_id),
            attributes = d.attributes || k.attributes,
            avatar_url = COALESCE(k.avatar_url, d.avatar_url),
            last_seen_at = GREATEST(k.last_seen_at, d.last_seen_at),
            created_at = LEAST(k.created_at, d.created_at),
            tags = COALESCE((
              SELECT array_agg(t ORDER BY t) FROM (
                SELECT DISTINCT ON (lower(t)) t
                  FROM unnest(k.tags || d.tags) WITH ORDINALITY AS u(t, ord)
                 ORDER BY lower(t), ord) x), '{}'),
            updated_at = now()
       FROM contacts d
      WHERE k.id = $1 AND d.id = $2`,
    [keepId, dropId],
  );
  await c.query("DELETE FROM contacts WHERE id = $1", [dropId]);
  return true;
}

/**
 * The identify-time half of the lead -> user conversion (Intercom converts the lead the same way):
 * fold every anonymous contact reachable from the conversation handles a widget holds locally into
 * the now-identified contact. Handles are matched against the channel identity map AND the
 * conversations themselves — a first-turn ticket carries the handle as external_channel_id, and a
 * server-id conversation is the ticket id. Handles the caller can't prove ownership of are harmless:
 * only an anonymous shell is ever absorbed, and knowing a conversation id already grants access to
 * that conversation (/public/conversation). Returns how many shells were absorbed.
 */
export async function absorbAnonymousByHandles(
  tenantId: string,
  keepId: string,
  channelType: string,
  handles: string[],
): Promise<number> {
  const uniq = [...new Set(handles.map((h) => (h ?? "").trim().toLowerCase()).filter(Boolean))].slice(0, 20);
  if (!keepId || !uniq.length) return 0;
  return withTenant(tenantId, async (c) => {
    const cand = await c.query(
      `SELECT DISTINCT contact_id FROM (
         SELECT ci.contact_id FROM contact_identities ci
          WHERE ci.channel_type = $2 AND lower(ci.external_id) = ANY($3::text[])
         UNION ALL
         SELECT t.contact_id FROM tickets t
          WHERE t.channel_type = $2
            AND (lower(t.external_channel_id) = ANY($3::text[]) OR t.id::text = ANY($3::text[]))
       ) x
       WHERE contact_id IS NOT NULL AND contact_id <> $1`,
      [keepId, channelType, uniq],
    );
    let folded = 0;
    for (const row of cand.rows as { contact_id: string }[]) {
      if (await absorbAnonymousContact(c, keepId, row.contact_id)) folded++;
    }
    // Bind any still-unclaimed handle to this contact, so the NEXT message on that conversation
    // threads onto the identified person instead of minting a fresh shell. A handle another contact
    // already owns is left alone (ON CONFLICT DO NOTHING) — we never re-point someone else's.
    for (const h of uniq) {
      await c.query(
        `INSERT INTO contact_identities (tenant_id, contact_id, channel_type, external_id)
         VALUES (current_tenant(), $1, $2, $3)
         ON CONFLICT (tenant_id, channel_type, lower(external_id)) DO NOTHING`,
        [keepId, channelType, h],
      );
    }
    return folded;
  });
}

/**
 * Resolve (or create) the contact behind an inbound message, on the ingest transaction's client so it
 * commits atomically with the ticket/message. Precedence:
 *   1. email present  → upsert the contact by email (the cross-channel unifier), then map this handle.
 *   2. else handle known → the existing identity's contact.
 *   3. else            → a brand-new contact, then map this handle.
 * Enriches only blank fields (an agent-curated name is never overwritten by a channel display name).
 * Returns the resolved contact id.
 */
export async function resolveContactForInbound(c: PoolClient, identity: IdentityInput): Promise<string> {
  const email = identity.email?.trim() || null;
  const name = identity.name?.trim() || null;
  const handle = identity.externalId?.trim() || null;

  if (email) {
    const r = await c.query(
      `INSERT INTO contacts (tenant_id, email, name)
       VALUES (current_tenant(), $1, COALESCE($2,''))
       ON CONFLICT (tenant_id, lower(email)) WHERE email IS NOT NULL AND email <> ''
       DO UPDATE SET
         name = CASE WHEN contacts.name = '' AND $2 IS NOT NULL THEN EXCLUDED.name ELSE contacts.name END,
         updated_at = now()
       RETURNING id`,
      [email, name],
    );
    const contactId = r.rows[0].id as string;
    // Unify identify vs ask: if this channel handle already mapped to a DIFFERENT (anonymous) contact
    // — the visitor asked before they identified — fold that shell onto the now-email-identified
    // contact and re-point the handle, instead of leaving two split contacts. A handle owned by an
    // already-IDENTIFIED contact is left where it is (absorb refuses): re-pointing it used to hand
    // that person's conversations to whoever sent the same conversation id.
    if (handle) {
      const prior = await c.query(
        `SELECT contact_id FROM contact_identities
          WHERE channel_type = $1 AND lower(external_id) = lower($2) AND contact_id <> $3 LIMIT 1`,
        [identity.channelType, handle, contactId],
      );
      if (prior.rowCount) await absorbAnonymousContact(c, contactId, prior.rows[0].contact_id as string);
    }
    await linkIdentity(c, contactId, identity.channelType, handle);
    return contactId;
  }

  if (handle) {
    const ex = await c.query(
      `SELECT contact_id FROM contact_identities
        WHERE channel_type = $1 AND lower(external_id) = lower($2) LIMIT 1`,
      [identity.channelType, handle],
    );
    if (ex.rowCount) return ex.rows[0].contact_id as string;
  }

  const ins = await c.query(
    `INSERT INTO contacts (tenant_id, name) VALUES (current_tenant(), COALESCE($1,'')) RETURNING id`,
    [name],
  );
  const contactId = ins.rows[0].id as string;
  await linkIdentity(c, contactId, identity.channelType, handle);
  return contactId;
}

/** A contact's linked channel handles (the "known on" section of the profile). */
export async function listContactIdentities(tenantId: string, contactId: string): Promise<ContactIdentityRow[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT id, channel_type, external_id, created_at
         FROM contact_identities WHERE contact_id = $1
        ORDER BY created_at ASC`,
      [contactId],
    );
    return r.rows as ContactIdentityRow[];
  });
}

export interface ContactTicket {
  id: string;
  subject: string;
  status: string;
  channel_type: string;
  sentiment: string | null;
  created_at: string;
  updated_at: string;
  last_message_body: string | null;
  last_message_author_type: string | null;
  last_message_at: string | null;
}

/** Sentiment mix across a contact's tickets — the trend surfaced on the contact profile. */
export interface SentimentTrend {
  positive: number;
  neutral: number;
  negative: number;
  total: number;
}

/**
 * A contact's ticket history — their conversations, each with the latest message.
 *
 * LINKAGE: tickets now carry a first-class `contact_id` (omnichannel, migration 0062), set at ingest
 * from the resolved cross-channel identity. So this is a direct FK join — every channel's tickets are
 * linked, not just email. A contact with no conversations returns an empty list.
 */
export async function contactHistory(
  tenantId: string,
  contactId: string,
): Promise<{ tickets: ContactTicket[]; sentiment: SentimentTrend }> {
  const empty: SentimentTrend = { positive: 0, neutral: 0, negative: 0, total: 0 };
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT t.id, t.subject, t.status, t.channel_type, t.sentiment, t.created_at, t.updated_at,
              lm.body AS last_message_body,
              lm.author_type AS last_message_author_type,
              lm.created_at AS last_message_at
         FROM tickets t
         LEFT JOIN LATERAL (
           SELECT body, author_type, created_at
             FROM messages m
            WHERE m.ticket_id = t.id AND m.tenant_id = t.tenant_id
            ORDER BY m.created_at DESC
            LIMIT 1
         ) lm ON true
        WHERE t.contact_id = $1
        ORDER BY t.updated_at DESC`,
      [contactId],
    );
    const tickets = r.rows as ContactTicket[];
    const sentiment: SentimentTrend = { ...empty, total: tickets.length };
    for (const t of tickets) {
      if (t.sentiment === "positive") sentiment.positive += 1;
      else if (t.sentiment === "negative") sentiment.negative += 1;
      else if (t.sentiment === "neutral") sentiment.neutral += 1;
    }
    return { tickets, sentiment };
  });
}

/**
 * Identity resolution: fold the `dropId` contact into `keepId`, then delete the duplicate. The kept
 * record wins on every field it already has; blank fields (name/company/email/external_id) are filled
 * from the dropped one, and attributes are merged (kept-contact keys win). Tickets now carry a
 * `contact_id` FK (omnichannel, migration 0062), so this RE-HOMES the dropped contact's conversations,
 * events, and channel identities onto the kept contact — a true identity merge, not just a directory
 * reconcile. Returns the merged contact, or null if either id is missing.
 */
/** A real human name composed from Intercom-style First/Last name attributes, or "" if absent. */
function composedName(c: ContactRow): string {
  const a = c.attributes ?? {};
  const first = String((a["First name"] ?? a["first name"] ?? "") as string).trim();
  const last = String((a["Last name"] ?? a["last name"] ?? "") as string).trim();
  return [first, last].filter(Boolean).join(" ");
}

/** Merge name precedence is QUALITY-aware, not positional — a channel handle (Discord "PaBi3") must
 *  never beat a real name just because it sits on the kept side. A composed First/Last name is the
 *  most trustworthy signal; else prefer the name attached to an email-identified contact; else fall
 *  back to whichever side has one. */
function pickMergedName(keep: ContactRow, drop: ContactRow): string {
  return (
    composedName(keep) ||
    composedName(drop) ||
    (keep.email ? keep.name : "") ||
    (drop.email ? drop.name : "") ||
    keep.name ||
    drop.name
  );
}

/** Earliest non-null timestamp — a marketing opt-out is sticky (most-restrictive wins on merge). */
function earliestTs(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a <= b ? a : b;
}
/** Latest non-null timestamp — presence keeps the most recent. */
function latestTs(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a >= b ? a : b;
}

export async function mergeContacts(
  tenantId: string,
  keepId: string,
  dropId: string,
): Promise<ContactRow | null> {
  if (keepId === dropId) return getContact(tenantId, keepId);
  const keep = await getContact(tenantId, keepId);
  const drop = await getContact(tenantId, dropId);
  if (!keep || !drop) return null;
  const mergedName = pickMergedName(keep, drop);
  const mergedCompany = keep.company || drop.company;
  const mergedCompanyId = keep.company_id ?? drop.company_id; // don't drop account linkage
  const mergedEmail = keep.email || drop.email || null;
  const mergedExternal = keep.external_id || drop.external_id || null;
  const mergedAttrs = { ...drop.attributes, ...keep.attributes };
  const mergedUnsub = earliestTs(keep.unsubscribed_at, drop.unsubscribed_at); // opt-out sticky
  // Source of the merged opt-out: 'api' only if every opted-out side was an api opt-out, so a merge
  // can't turn a person's own opt-out into one the public API may undo. Legacy null stays null.
  const optedOutSources = [keep, drop].filter((x) => x.unsubscribed_at).map((x) => x.unsubscribed_source);
  const mergedUnsubSource = !mergedUnsub
    ? null
    : optedOutSources.every((s) => s === "api")
      ? "api"
      : optedOutSources.find((s) => s !== "api") ?? null;
  const mergedAvatar = keep.avatar_url ?? drop.avatar_url;
  const mergedSeen = latestTs(keep.last_seen_at, drop.last_seen_at);
  return withTenant(tenantId, async (c) => {
    // Re-home ALL of the dropped contact's conversations, INCLUDING Discord thread-tickets — those
    // were being orphaned (contact_id → NULL) and vanishing from the survivor. tickets_thread_uq keys
    // on external_thread_id, not contact_id, so re-homing them is safe.
    await c.query("UPDATE tickets SET contact_id = $1 WHERE contact_id = $2", [keepId, dropId]);
    // Preserve authored-message attribution across the merge for thread-tickets and everything else.
    await c.query("UPDATE messages SET author_contact_id = $1 WHERE author_contact_id = $2", [keepId, dropId]);
    await c.query("UPDATE contact_events SET contact_id = $1 WHERE contact_id = $2", [keepId, dropId]);
    // Move channel identities that don't collide with one the kept contact already owns; the rest
    // cascade-delete with the dropped contact below (the kept handle wins).
    await c.query(
      `UPDATE contact_identities ci SET contact_id = $1
        WHERE ci.contact_id = $2
          AND NOT EXISTS (
            SELECT 1 FROM contact_identities k
             WHERE k.tenant_id = ci.tenant_id AND k.contact_id = $1
               AND k.channel_type = ci.channel_type
               AND lower(k.external_id) = lower(ci.external_id))`,
      [keepId, dropId],
    );
    // Re-home the dropped contact's company memberships (0111) onto the kept contact — union of both
    // accounts. Move as NON-primary (the kept contact's primary wins; ensurePrimaryCompany reconciles
    // below); rows that already exist on the kept side cascade-delete with the dropped contact.
    await c.query(
      `UPDATE contact_companies cc SET contact_id = $1, is_primary = false
        WHERE cc.contact_id = $2
          AND NOT EXISTS (
            SELECT 1 FROM contact_companies k
             WHERE k.tenant_id = cc.tenant_id AND k.contact_id = $1 AND k.company_id = cc.company_id)`,
      [keepId, dropId],
    );
    // Delete the duplicate (cascading its leftover identities + company memberships) so a unique
    // email/external_id it holds can't collide with the kept contact's fill-in.
    await c.query("DELETE FROM contacts WHERE id = $1", [dropId]);
    await c.query(
      `UPDATE contacts
          SET name = $2, company = $3, company_id = $4, email = $5, external_id = $6,
              attributes = $7::jsonb, unsubscribed_at = $8::timestamptz, avatar_url = $9,
              last_seen_at = $10::timestamptz, unsubscribed_source = $11, updated_at = now()
        WHERE id = $1`,
      [keepId, mergedName, mergedCompany, mergedCompanyId, mergedEmail, mergedExternal,
       JSON.stringify(mergedAttrs), mergedUnsub, mergedAvatar, mergedSeen, mergedUnsubSource],
    );
    // Pin the junction primary to the merged company (or clear it when neither side had one).
    if (mergedCompanyId) await ensurePrimaryCompany(c, keepId, mergedCompanyId);
    else await c.query(`DELETE FROM contact_companies WHERE contact_id = $1 AND is_primary`, [keepId]);
    const sel = await c.query(`SELECT ${DERIVED_COLS} FROM contacts WHERE id = $1`, [keepId]);
    return sel.rowCount ? (sel.rows[0] as ContactRow) : null;
  });
}

// ── Tags (0123) ──────────────────────────────────────────────────────────────

/** Trim, collapse inner whitespace, cap at 60 chars, drop empties, dedupe case-insensitively
 *  (first spelling wins), sort. */
export function normalizeTags(tags: unknown[]): string[] {
  const seen = new Map<string, string>();
  for (const t of tags) {
    if (typeof t !== "string") continue;
    const v = t.trim().replace(/\s+/g, " ").slice(0, 60);
    if (v && !seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** SQL expression: `tags` plus/minus the given arrays, deduped case-insensitively (the spelling
 *  already on the contact wins over an incoming variant — ordinality puts existing tags first) and
 *  sorted. */
const MERGED_TAGS_SQL = (addParam: string, removeParam: string) => `COALESCE((
  SELECT array_agg(t ORDER BY t) FROM (
    SELECT DISTINCT ON (lower(t)) t FROM unnest(tags || ${addParam}::text[]) WITH ORDINALITY AS u(t, ord)
     WHERE lower(t) <> ALL (SELECT lower(r) FROM unnest(${removeParam}::text[]) r)
     ORDER BY lower(t), ord
  ) d), '{}')`;

/** Add / remove tags on contacts by id (bulk action). Returns how many contacts changed. */
export async function tagContacts(
  tenantId: string,
  ids: string[],
  add: string[],
  remove: string[] = [],
): Promise<number> {
  const a = normalizeTags(add);
  const r = normalizeTags(remove);
  if (!ids.length || (!a.length && !r.length)) return 0;
  return withTenant(tenantId, async (c) => {
    const res = await c.query(
      `UPDATE contacts SET tags = ${MERGED_TAGS_SQL("$2", "$3")}, updated_at = now()
        WHERE id = ANY($1::uuid[]) AND tags IS DISTINCT FROM ${MERGED_TAGS_SQL("$2", "$3")}`,
      [ids, a, r],
    );
    return res.rowCount ?? 0;
  });
}

/** Add tags to every contact identified by the rows (external_id, else email) — the import's
 *  tagging pass, run after its writes so new and existing contacts alike carry the tag. */
export async function tagContactsByIdentity(
  tenantId: string,
  rows: ContactInputShape[],
  add: string[],
): Promise<number> {
  const a = normalizeTags(add);
  const exts = [...new Set(rows.map((r) => r.external_id).filter((x): x is string => !!x))];
  const emails = [...new Set(rows.map((r) => r.email?.toLowerCase()).filter((x): x is string => !!x))];
  if (!a.length || (!exts.length && !emails.length)) return 0;
  return withTenant(tenantId, async (c) => {
    const res = await c.query(
      `UPDATE contacts SET tags = ${MERGED_TAGS_SQL("$3", "'{}'")}, updated_at = now()
        WHERE (external_id = ANY($1::text[]) OR (email <> '' AND lower(email) = ANY($2::text[])))
          AND spam_at IS NULL`,
      [exts, emails, a],
    );
    return res.rowCount ?? 0;
  });
}

/** Indexes of the rows that match an EXISTING contact (external_id, else email) — the import uses
 *  it to leave existing people untouched and only tag them. */
export async function existingRowIndexes(tenantId: string, rows: ContactInputShape[]): Promise<Set<number>> {
  const exts = rows.map((r) => r.external_id).filter((x): x is string => !!x);
  const emails = rows.map((r) => r.email?.toLowerCase()).filter((x): x is string => !!x);
  const out = new Set<number>();
  if (!exts.length && !emails.length) return out;
  const found = await withTenant(tenantId, (c) =>
    c.query(
      `SELECT external_id, lower(email) AS email FROM contacts
        WHERE external_id = ANY($1::text[]) OR (email <> '' AND lower(email) = ANY($2::text[]))`,
      [exts, emails],
    ),
  );
  const extSet = new Set(found.rows.map((r) => r.external_id).filter(Boolean));
  const emailSet = new Set(found.rows.map((r) => r.email).filter(Boolean));
  rows.forEach((r, i) => {
    if ((r.external_id && extSet.has(r.external_id)) || (r.email && emailSet.has(r.email.toLowerCase()))) out.add(i);
  });
  return out;
}

/** Every tag in use with its contact count, most used first (filter suggestions, tag pickers). */
export async function listContactTags(tenantId: string): Promise<{ tag: string; count: number }[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT t AS tag, count(*)::int AS count FROM contacts, unnest(tags) t
        WHERE spam_at IS NULL GROUP BY t ORDER BY count(*) DESC, t LIMIT 500`,
    );
    return r.rows as { tag: string; count: number }[];
  });
}

/** Import rows that carry a name but no email / external id (e.g. a badge scan). They can't be
 *  emailed and have no dedup key, so a re-import matches them by name + company among contacts that
 *  have neither an email nor an external id — never onto an identified person. Existing matches only
 *  gain the tags (their details stay) unless `updateExisting`; new ones are created with the tags. */
export async function upsertContactsWithoutEmail(
  tenantId: string,
  rows: ContactInputShape[],
  opts: { tags?: string[]; updateExisting?: boolean } = {},
): Promise<{ created: number; updated: number; tagged: number; existing: number }> {
  const tags = normalizeTags(opts.tags ?? []);
  return withTenant(tenantId, async (c) => {
    let created = 0;
    let updated = 0;
    let tagged = 0;
    let existing = 0;
    for (const r of rows) {
      const name = (r.name ?? "").trim();
      if (!name) continue;
      const company = (r.company ?? "").trim();
      const found = await c.query(
        `SELECT id FROM contacts
          WHERE (email IS NULL OR email = '') AND external_id IS NULL AND spam_at IS NULL
            AND lower(name) = lower($1) AND lower(coalesce(company, '')) = lower($2)
          ORDER BY created_at LIMIT 1`,
        [name, company],
      );
      if (found.rowCount) {
        const id = found.rows[0].id as string;
        const res = await c.query(
          `UPDATE contacts SET
             tags = ${MERGED_TAGS_SQL("$2", "'{}'")},
             attributes = CASE WHEN $3::boolean THEN attributes || COALESCE($4::jsonb, '{}'::jsonb) ELSE attributes END,
             updated_at = now()
           WHERE id = $1
           RETURNING (cardinality($2::text[]) > 0) AS tagged`,
          [id, tags, opts.updateExisting === true, jsonOrNull(r.attributes)],
        );
        existing++;
        if (opts.updateExisting) updated++;
        if (res.rows[0]?.tagged) tagged++;
        continue;
      }
      const ins = await c.query(
        `INSERT INTO contacts (tenant_id, name, company, company_id, attributes, tags)
         VALUES (current_tenant(), $1, $2, $3, COALESCE($4::jsonb, '{}'::jsonb), $5::text[])
         RETURNING id`,
        [name, company, r.company_id ?? null, jsonOrNull(r.attributes), tags],
      );
      if (r.company_id) await ensurePrimaryCompany(c, ins.rows[0].id as string, r.company_id);
      created++;
      if (tags.length) tagged++;
    }
    return { created, updated, tagged, existing };
  });
}
