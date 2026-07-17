import { withTenant } from "@repo/db";
import type { PoolClient } from "pg";
import type { ContactFilterCondition, ContactSortField } from "@repo/contracts";

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
}

/** A partial patch for a contact — the fields a caller may set. Undefined = leave alone. */
export interface ContactInputShape {
  external_id?: string;
  email?: string;
  name?: string;
  company?: string;
  company_id?: string | null;
  attributes?: Record<string, unknown>;
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
  "id, external_id, email, name, company, company_id, attributes, created_at, updated_at, avatar_url, unsubscribed_at";

// Read-side derived columns (list/get): identity status, first channel identity, presence.
// "Identified" = human-recognizable (name or email); everything else renders as an anonymous
// visitor. "online" derives from last_seen_at so the polling widget counts without WS hooks.
const DERIVED_COLS = `${COLS}, last_seen_at,
  (coalesce(name,'') <> '' OR coalesce(email,'') <> '') AS identified,
  (SELECT ci.channel_type FROM contact_identities ci WHERE ci.contact_id = contacts.id
    ORDER BY ci.created_at ASC LIMIT 1) AS primary_channel,
  (last_seen_at IS NOT NULL AND last_seen_at > now() - interval '3 minutes') AS online`;

// Whitelisted sortable/filterable core columns → safe SQL identifiers. Field names can't be
// parameterized, so ONLY these literal identifiers ever reach the query; anything else is an
// attribute lookup (attributes ->> $key, key bound as a param) or ignored.
const CORE_COL: Record<string, string> = {
  name: "name",
  email: "email",
  company: "company",
  created_at: "created_at",
  updated_at: "updated_at",
  unsubscribed_at: "unsubscribed_at",
};
const DATE_FIELDS = new Set(["created_at", "updated_at", "unsubscribed_at"]);

/** Compile one filter-builder condition into a SQL clause, binding params positionally into
 *  the shared params array. Unknown fields / incomplete value-ops are skipped (the schema
 *  validates shape upstream; this is the last-line safety). Attribute keys are always bound
 *  as params — never interpolated — so free-form keys can't inject. */
function compileCondition(cond: ContactFilterCondition, clauses: string[], params: unknown[]): void {
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
    params.push(filters.company.trim());
    clauses.push(`company = $${params.length}`);
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
  for (const cond of filters.conditions ?? []) {
    compileCondition(cond, clauses, params);
  }
  // OR groups: compile each group into its own clause list, AND within, OR across. A group
  // whose conditions all get skipped disappears; if EVERY group vanishes, so does the OR.
  const groupSqls: string[] = [];
  for (const group of filters.conditionGroups ?? []) {
    const groupClauses: string[] = [];
    for (const cond of group) compileCondition(cond, groupClauses, params);
    if (groupClauses.length) groupSqls.push(`(${groupClauses.join(" AND ")})`);
  }
  if (groupSqls.length) clauses.push(`(${groupSqls.join(" OR ")})`);
  return { clauses, params };
}

/** Fire an outbound webhook event, fire-and-forget. Dynamic import keeps webhooks out of
 *  the contacts module graph and matches the ingest⇄autoreply pattern; errors are
 *  swallowed so a webhook never affects the contact write that just committed. */
function fireWebhook(tenantId: string, event: string, data: unknown): void {
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

/** Throttled presence bump — any widget touch (ask / poll / identify / track) marks the contact
 *  seen. The 60s throttle keeps the polling widget from writing on every poll; "online" derives
 *  from this at read time, so no disconnect hook is needed. Fire-and-forget at call sites. */
export async function bumpContactSeen(tenantId: string, contactId: string): Promise<void> {
  await withTenant(tenantId, async (c) => {
    await c.query(
      `UPDATE contacts SET last_seen_at = now()
        WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '60 seconds')`,
      [contactId],
    );
  }).catch(() => {}); // presence is best-effort — never fail the request over it
}

/** Plain insert (no conflict handling — use upsertContact for idempotent sync). Throws
 *  a pg 23505 if external_id / email already exists for the tenant. */
export async function createContact(tenantId: string, input: ContactInputShape): Promise<ContactRow> {
  const contact = await withTenant(tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO contacts (tenant_id, external_id, email, name, company, company_id, attributes)
       VALUES (current_tenant(), $1, $2, COALESCE($3,''), COALESCE($4,''), $5, COALESCE($6,'{}'::jsonb))
       RETURNING ${COLS}`,
      [input.external_id ?? null, input.email ?? null, input.name ?? null, input.company ?? null, input.company_id ?? null, jsonOrNull(input.attributes)],
    );
    return r.rows[0] as ContactRow;
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
  const sets: string[] = [];
  const params: unknown[] = [id];
  const set = (col: string, val: unknown): void => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  if (input.external_id !== undefined) set("external_id", input.external_id);
  if (input.email !== undefined) set("email", input.email);
  if (input.name !== undefined) set("name", input.name);
  if (input.company !== undefined) set("company", input.company);
  if (input.company_id !== undefined) set("company_id", input.company_id);
  if (input.attributes !== undefined) {
    params.push(JSON.stringify(input.attributes));
    sets.push(`attributes = $${params.length}::jsonb`);
  }
  if (!sets.length) return getContact(tenantId, id); // nothing to change
  sets.push("updated_at = now()");
  const contact = await withTenant(tenantId, async (c) => {
    const r = await c.query(
      `UPDATE contacts SET ${sets.join(", ")} WHERE id = $1 RETURNING ${COLS}`,
      params,
    );
    return r.rowCount ? (r.rows[0] as ContactRow) : null;
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
  const result = await withTenant(tenantId, async (c) => {
    if (input.external_id) {
      const r = await c.query(
        `INSERT INTO contacts (tenant_id, external_id, email, name, company, attributes)
         VALUES (current_tenant(), $1, $2, COALESCE($3,''), COALESCE($4,''), COALESCE($5,'{}'::jsonb))
         ON CONFLICT (tenant_id, external_id) WHERE external_id IS NOT NULL
         DO UPDATE SET
           email = COALESCE(EXCLUDED.email, contacts.email),
           name = CASE WHEN $3 IS NULL THEN contacts.name ELSE EXCLUDED.name END,
           company = CASE WHEN $4 IS NULL THEN contacts.company ELSE EXCLUDED.company END,
           attributes = contacts.attributes || COALESCE($5,'{}'::jsonb),
           updated_at = now()
         RETURNING ${COLS}, (xmax = 0) AS created`,
        [input.external_id, input.email ?? null, input.name ?? null, input.company ?? null, jsonOrNull(input.attributes)],
      );
      return splitUpsert(r.rows[0]);
    }
    if (input.email) {
      const r = await c.query(
        `INSERT INTO contacts (tenant_id, email, name, company, attributes)
         VALUES (current_tenant(), $1, COALESCE($2,''), COALESCE($3,''), COALESCE($4,'{}'::jsonb))
         ON CONFLICT (tenant_id, lower(email)) WHERE email IS NOT NULL AND email <> ''
         DO UPDATE SET
           name = CASE WHEN $2 IS NULL THEN contacts.name ELSE EXCLUDED.name END,
           company = CASE WHEN $3 IS NULL THEN contacts.company ELSE EXCLUDED.company END,
           attributes = contacts.attributes || COALESCE($4,'{}'::jsonb),
           updated_at = now()
         RETURNING ${COLS}, (xmax = 0) AS created`,
        [input.email, input.name ?? null, input.company ?? null, jsonOrNull(input.attributes)],
      );
      return splitUpsert(r.rows[0]);
    }
    // No idempotency key — a plain insert (always created).
    const r = await c.query(
      `INSERT INTO contacts (tenant_id, name, company, attributes)
       VALUES (current_tenant(), COALESCE($1,''), COALESCE($2,''), COALESCE($3,'{}'::jsonb))
       RETURNING ${COLS}`,
      [input.name ?? null, input.company ?? null, jsonOrNull(input.attributes)],
    );
    return { contact: r.rows[0] as ContactRow, created: true };
  });
  fireWebhook(tenantId, result.created ? "contact.created" : "contact.updated", result.contact);
  return result;
}

function splitUpsert(row: ContactRow & { created: boolean }): UpsertResult {
  const { created, ...contact } = row;
  return { contact: contact as ContactRow, created };
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
      if (res) created++;
      else updated++;
    }
    return { created, updated };
  });
}

/** The single-row upsert body, reused by bulkUpsertContacts so the whole batch shares one
 *  transaction. Returns true if the row was inserted, false if it updated an existing row. */
async function upsertOne(
  c: import("pg").PoolClient,
  input: ContactInputShape,
): Promise<boolean> {
  if (input.external_id) {
    const r = await c.query(
      `INSERT INTO contacts (tenant_id, external_id, email, name, company, attributes)
       VALUES (current_tenant(), $1, $2, COALESCE($3,''), COALESCE($4,''), COALESCE($5,'{}'::jsonb))
       ON CONFLICT (tenant_id, external_id) WHERE external_id IS NOT NULL
       DO UPDATE SET
         email = COALESCE(EXCLUDED.email, contacts.email),
         name = CASE WHEN $3 IS NULL THEN contacts.name ELSE EXCLUDED.name END,
         company = CASE WHEN $4 IS NULL THEN contacts.company ELSE EXCLUDED.company END,
         attributes = contacts.attributes || COALESCE($5,'{}'::jsonb),
         updated_at = now()
       RETURNING (xmax = 0) AS created`,
      [input.external_id, input.email ?? null, input.name ?? null, input.company ?? null, jsonOrNull(input.attributes)],
    );
    return r.rows[0].created as boolean;
  }
  if (input.email) {
    const r = await c.query(
      `INSERT INTO contacts (tenant_id, email, name, company, attributes)
       VALUES (current_tenant(), $1, COALESCE($2,''), COALESCE($3,''), COALESCE($4,'{}'::jsonb))
       ON CONFLICT (tenant_id, lower(email)) WHERE email IS NOT NULL AND email <> ''
       DO UPDATE SET
         name = CASE WHEN $2 IS NULL THEN contacts.name ELSE EXCLUDED.name END,
         company = CASE WHEN $3 IS NULL THEN contacts.company ELSE EXCLUDED.company END,
         attributes = contacts.attributes || COALESCE($4,'{}'::jsonb),
         updated_at = now()
       RETURNING (xmax = 0) AS created`,
      [input.email, input.name ?? null, input.company ?? null, jsonOrNull(input.attributes)],
    );
    return r.rows[0].created as boolean;
  }
  await c.query(
    `INSERT INTO contacts (tenant_id, name, company, attributes)
     VALUES (current_tenant(), COALESCE($1,''), COALESCE($2,''), COALESCE($3,'{}'::jsonb))`,
    [input.name ?? null, input.company ?? null, jsonOrNull(input.attributes)],
  );
  return true;
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
export async function mergeContacts(
  tenantId: string,
  keepId: string,
  dropId: string,
): Promise<ContactRow | null> {
  if (keepId === dropId) return getContact(tenantId, keepId);
  const keep = await getContact(tenantId, keepId);
  const drop = await getContact(tenantId, dropId);
  if (!keep || !drop) return null;
  const merged: ContactInputShape = {
    name: keep.name || drop.name,
    company: keep.company || drop.company,
    email: keep.email || drop.email || undefined,
    external_id: keep.external_id || drop.external_id || undefined,
    attributes: { ...drop.attributes, ...keep.attributes },
  };
  return withTenant(tenantId, async (c) => {
    // Re-home only NON-thread conversations; a Discord thread-ticket stays keyed to its
    // external_thread_id and must not be collapsed across the merge (§5.7).
    await c.query("UPDATE tickets SET contact_id = $1 WHERE contact_id = $2 AND external_thread_id IS NULL", [keepId, dropId]);
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
    // Delete the duplicate (cascading its leftover identities) so a unique email/external_id it holds
    // can't collide with the kept contact's fill-in (both live under the same tenant partial indexes).
    await c.query("DELETE FROM contacts WHERE id = $1", [dropId]);
    const r = await c.query(
      `UPDATE contacts
          SET name = $2, company = $3, email = $4, external_id = $5,
              attributes = $6::jsonb, updated_at = now()
        WHERE id = $1
        RETURNING ${COLS}`,
      [keepId, merged.name, merged.company, merged.email ?? null, merged.external_id ?? null,
       JSON.stringify(merged.attributes ?? {})],
    );
    return r.rowCount ? (r.rows[0] as ContactRow) : null;
  });
}
