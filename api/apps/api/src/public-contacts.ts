import { withTenant } from "@repo/db";
import type { PoolClient } from "pg";
import { PublicContactInput } from "@repo/contracts";
import {
  fireWebhook, optOutSourceSql, absorbLeadContact, CONTACT_ACCOUNT_STATUS_SQL,
  type UnsubscribeSource, type ContactAccountStatus,
} from "./contacts.js";

// The public (api-key) contacts surface: server-to-server sync from an external system of record,
// keyed by THAT system's stable id (contacts.external_id). Deliberately stricter than the console's
// upsertOne, which folds an unknown external_id onto whichever contact holds the email and keeps the
// old id — for a sync keyed by id that silently loses the mapping. Here:
//   - external_id match            → update that contact
//   - no id match, email held by a contact WITHOUT an external_id (widget/email-created)
//                                  → attach the id to it (dedup), matched_by = "email"
//   - id match AND the email is held by a LEAD (no external_id of its own — an imported row, an
//     email sender, a widget visitor): the account just moved onto an address we already knew
//                                  → fold the lead into the synced contact, warning "lead_merged"
//   - the email is held by a contact with a DIFFERENT external_id (two real accounts, one email)
//                                  → conflict; nothing written
//   - otherwise                    → create
// Consent (`subscribed`) opts out with source 'api'; re-subscribing is allowed only for an 'api'
// opt-out (a person's own / an agent's / an import's opt-out needs the forced subscription call).

export interface PublicContact {
  id: string;
  external_id: string | null;
  email: string | null;
  name: string;
  subscribed: boolean;
  unsubscribed_at: string | null;
  unsubscribed_source: UnsubscribeSource | null;
  /** customer / user / former / lead — see CONTACT_ACCOUNT_STATUS_SQL. */
  account_status: ContactAccountStatus;
  synced_at: string | null;
  sync_removed_at: string | null;
  created_at: string;
  updated_at: string;
}

const PUBLIC_COLS = `id, external_id, email, name, unsubscribed_at, unsubscribed_source, synced_at, sync_removed_at,
  created_at, updated_at, ${CONTACT_ACCOUNT_STATUS_SQL} AS account_status`;

function toPublic(row: Record<string, unknown>): PublicContact {
  const ts = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null));
  return {
    id: row.id as string,
    external_id: (row.external_id as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    name: (row.name as string) ?? "",
    subscribed: !row.unsubscribed_at,
    unsubscribed_at: ts(row.unsubscribed_at),
    unsubscribed_source: (row.unsubscribed_source as UnsubscribeSource | null) ?? null,
    account_status: row.account_status as ContactAccountStatus,
    synced_at: ts(row.synced_at),
    sync_removed_at: ts(row.sync_removed_at),
    created_at: ts(row.created_at) as string,
    updated_at: ts(row.updated_at) as string,
  };
}

export type MatchedBy = "external_id" | "email";

export type UpsertOutcome =
  | { status: "created" | "updated"; contact: PublicContact; matched_by: MatchedBy | null; warnings: string[] }
  | { status: "conflict"; error: string; conflict?: { contact_id: string; external_id: string | null } };

/** The resubscribe-blocked warning/error code, shared by upsert (warning) and subscription (409). */
export const RESUBSCRIBE_BLOCKED = "resubscribe_blocked";

/** Warning code: this upsert absorbed a never-synced contact (a lead) that was holding the email. */
export const LEAD_MERGED = "lead_merged";

/** One strict upsert on the caller's transaction. Never throws for a business conflict (returns
 *  status "conflict"); a unique-violation race still throws pg 23505 for the caller to map. */
async function upsertStrict(c: PoolClient, input: PublicContactInput): Promise<UpsertOutcome> {
  const email = input.email || null;

  const byId = await c.query(
    `SELECT id, unsubscribed_at, unsubscribed_source FROM contacts WHERE external_id = $1 LIMIT 1`,
    [input.external_id],
  );
  let target = byId.rows[0] as { id: string; unsubscribed_at: Date | null; unsubscribed_source: string | null } | undefined;
  let matchedBy: MatchedBy | null = target ? "external_id" : null;

  const warnings: string[] = [];
  if (email) {
    const holder = (
      await c.query(
        `SELECT id, external_id, unsubscribed_at, unsubscribed_source FROM contacts
          WHERE email <> '' AND lower(email) = lower($1) LIMIT 1`,
        [email],
      )
    ).rows[0] as { id: string; external_id: string | null; unsubscribed_at: Date | null; unsubscribed_source: string | null } | undefined;
    if (holder && holder.id !== target?.id) {
      if (holder.external_id) {
        // Two synced accounts claiming one address. Never merged automatically — which of the two is
        // the person is a question only the system of record can answer.
        return {
          status: "conflict",
          error: target
            ? "email already belongs to another contact"
            : "email already belongs to a contact with a different external_id",
          conflict: { contact_id: holder.id, external_id: holder.external_id },
        };
      }
      if (target) {
        // The address moved onto this account and a LEAD holds it — the person we met before they
        // signed up (imported list, email sender, widget visitor). Same human: convert the lead into
        // this account instead of refusing the sync and leaving the email stuck on the old value.
        // Their conversations, tags, first-seen and opt-out come along (absorbLeadContact); the
        // address itself is freed by the fold, so the UPDATE below can take it.
        if (await absorbLeadContact(c, target.id, holder.id)) warnings.push(LEAD_MERGED);
      } else {
        target = holder;
        matchedBy = "email";
      }
    }
  }

  if (!target) {
    const optOut = input.subscribed === false;
    const ins = await c.query(
      `INSERT INTO contacts (tenant_id, external_id, email, name, unsubscribed_at, unsubscribed_source, synced_at)
       VALUES (current_tenant(), $1, $2, COALESCE($3, ''),
               CASE WHEN $4 THEN now() END, CASE WHEN $4 THEN 'api' END, now())
       RETURNING ${PUBLIC_COLS}`,
      [input.external_id, email, input.name ?? null, optOut],
    );
    return { status: "created", contact: toPublic(ins.rows[0]), matched_by: null, warnings };
  }

  // consent: 'out' opt out, 'in' clear an api opt-out, null leave alone.
  let consent: "out" | "in" | null = null;
  if (input.subscribed === false) consent = "out";
  else if (input.subscribed === true && target.unsubscribed_at) {
    if (target.unsubscribed_source === "api") consent = "in";
    else warnings.push(RESUBSCRIBE_BLOCKED);
  }

  const upd = await c.query(
    `UPDATE contacts SET
       external_id = $2,
       email = COALESCE($3, email),
       name = COALESCE($4, name),
       unsubscribed_source = CASE $5::text WHEN 'out' THEN ${optOutSourceSql("'api'")}
                                           WHEN 'in' THEN NULL ELSE unsubscribed_source END,
       unsubscribed_at = CASE $5::text WHEN 'out' THEN COALESCE(unsubscribed_at, now())
                                       WHEN 'in' THEN NULL ELSE unsubscribed_at END,
       synced_at = now(),
       sync_removed_at = NULL,
       updated_at = now()
     WHERE id = $1
     RETURNING ${PUBLIC_COLS}`,
    [target.id, input.external_id, email, input.name ?? null, consent],
  );
  return { status: "updated", contact: toPublic(upd.rows[0]), matched_by: matchedBy, warnings };
}

const isUniqueViolation = (e: unknown) => (e as { code?: string }).code === "23505";
const RACE_CONFLICT = "concurrent write to the same email or external_id — retry";

/** Single upsert (POST /v1/public/contacts/upsert). */
export async function publicUpsertContact(tenantId: string, input: PublicContactInput): Promise<UpsertOutcome> {
  let out: UpsertOutcome;
  try {
    out = await withTenant(tenantId, (c) => upsertStrict(c, input));
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    return { status: "conflict", error: RACE_CONFLICT };
  }
  if (out.status !== "conflict") {
    fireWebhook(tenantId, out.status === "created" ? "contact.created" : "contact.updated", out.contact);
  }
  return out;
}

export interface BulkRowResult {
  index: number;
  external_id: string | null;
  status: "created" | "updated" | "conflict" | "invalid";
  contact_id?: string;
  matched_by?: MatchedBy | null;
  warnings?: string[];
  error?: unknown;
  conflict?: { contact_id: string; external_id: string | null };
}

/** Bulk upsert (POST /v1/public/contacts/bulk): one transaction, one SAVEPOINT per row, so a bad or
 *  conflicting row is reported and skipped while every other row commits. Rows apply in order (a
 *  repeated external_id later in the batch updates the earlier one). Like the console bulk import, it
 *  fires no per-row webhooks. */
export async function publicBulkUpsertContacts(
  tenantId: string,
  rows: unknown[],
): Promise<{ created: number; updated: number; conflicts: number; invalid: number; results: BulkRowResult[] }> {
  const results = await withTenant(tenantId, async (c) => {
    const out: BulkRowResult[] = [];
    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i] as { external_id?: unknown } | null;
      const rawId = raw && typeof raw.external_id === "string" ? raw.external_id : null;
      const parsed = PublicContactInput.safeParse(rows[i]);
      if (!parsed.success) {
        out.push({ index: i, external_id: rawId, status: "invalid", error: parsed.error.flatten() });
        continue;
      }
      await c.query("SAVEPOINT row");
      try {
        const r = await upsertStrict(c, parsed.data);
        await c.query("RELEASE SAVEPOINT row");
        out.push(
          r.status === "conflict"
            ? { index: i, external_id: parsed.data.external_id, status: "conflict", error: r.error, conflict: r.conflict }
            : { index: i, external_id: parsed.data.external_id, status: r.status, contact_id: r.contact.id, matched_by: r.matched_by, warnings: r.warnings },
        );
      } catch (e) {
        await c.query("ROLLBACK TO SAVEPOINT row");
        if (!isUniqueViolation(e)) throw e;
        out.push({ index: i, external_id: parsed.data.external_id, status: "conflict", error: RACE_CONFLICT });
      }
    }
    return out;
  });
  const count = (s: BulkRowResult["status"]) => results.filter((r) => r.status === s).length;
  return { created: count("created"), updated: count("updated"), conflicts: count("conflict"), invalid: count("invalid"), results };
}

/** Look up one contact by external_id (GET /v1/public/contacts?external_id=). */
export async function publicGetContact(tenantId: string, externalId: string): Promise<PublicContact | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(`SELECT ${PUBLIC_COLS} FROM contacts WHERE external_id = $1 LIMIT 1`, [externalId]);
    return r.rowCount ? toPublic(r.rows[0]) : null;
  });
}

export type SubscriptionOutcome =
  | { status: "ok"; contact: PublicContact; forced: boolean }
  | { status: "not_found" }
  | { status: "blocked"; unsubscribed_at: string | null; unsubscribed_source: UnsubscribeSource | null };

/** Set marketing consent by external_id (POST /v1/public/contacts/subscription). Opting out always
 *  succeeds (idempotent; keeps the first opt-out's time and source). Re-subscribing clears an 'api'
 *  opt-out; any other opt-out needs `force` (the caller audits forced ones). */
export async function publicSetSubscription(
  tenantId: string,
  externalId: string,
  subscribed: boolean,
  force: boolean,
): Promise<SubscriptionOutcome> {
  const out = await withTenant(tenantId, async (c): Promise<SubscriptionOutcome> => {
    const cur = await c.query(
      `SELECT id, unsubscribed_at, unsubscribed_source FROM contacts WHERE external_id = $1 LIMIT 1 FOR UPDATE`,
      [externalId],
    );
    if (!cur.rowCount) return { status: "not_found" };
    const row = cur.rows[0] as { id: string; unsubscribed_at: Date | null; unsubscribed_source: UnsubscribeSource | null };

    if (!subscribed) {
      const r = await c.query(
        `UPDATE contacts SET unsubscribed_source = ${optOutSourceSql("'api'")},
                unsubscribed_at = COALESCE(unsubscribed_at, now()), updated_at = now()
          WHERE id = $1 RETURNING ${PUBLIC_COLS}`,
        [row.id],
      );
      return { status: "ok", contact: toPublic(r.rows[0]), forced: false };
    }

    const forced = !!row.unsubscribed_at && row.unsubscribed_source !== "api";
    if (forced && !force) {
      return { status: "blocked", unsubscribed_at: row.unsubscribed_at?.toISOString() ?? null, unsubscribed_source: row.unsubscribed_source };
    }
    const r = await c.query(
      `UPDATE contacts SET unsubscribed_at = NULL, unsubscribed_source = NULL,
              updated_at = CASE WHEN unsubscribed_at IS NULL THEN updated_at ELSE now() END
        WHERE id = $1 RETURNING ${PUBLIC_COLS}`,
      [row.id],
    );
    return { status: "ok", contact: toPublic(r.rows[0]), forced };
  });
  if (out.status === "ok") fireWebhook(tenantId, "contact.updated", out.contact);
  return out;
}

/** The system of record deleted this person (POST /v1/public/contacts/remove). Soft: the contact,
 *  its conversations and consent stay; it reads as 'former' until a later upsert revives it. The
 *  person's sync-owned company memberships go (they no longer belong to those accounts). */
export async function publicRemoveContact(tenantId: string, externalId: string): Promise<PublicContact | null> {
  const out = await withTenant(tenantId, async (c) => {
    const r = await c.query(
      `UPDATE contacts SET sync_removed_at = COALESCE(sync_removed_at, now()), updated_at = now()
        WHERE external_id = $1 RETURNING id`,
      [externalId],
    );
    if (!r.rowCount) return null;
    const id = r.rows[0].id as string;
    await removeSyncMemberships(c, id);
    return toPublic((await c.query(`SELECT ${PUBLIC_COLS} FROM contacts WHERE id = $1`, [id])).rows[0]);
  });
  if (out) fireWebhook(tenantId, "contact.updated", out);
  return out;
}

/** Drop a contact's sync-owned memberships (optionally only for some companies) and re-pin the
 *  primary + the denormalized contacts.company_id/company columns to what's left. Shared with the
 *  members sync in public-accounts.ts. */
export async function removeSyncMemberships(c: PoolClient, contactId: string, companyIds?: string[]): Promise<void> {
  if (companyIds) {
    await c.query(
      `DELETE FROM contact_companies WHERE contact_id = $1 AND source = 'sync' AND company_id = ANY($2::uuid[])`,
      [contactId, companyIds],
    );
  } else {
    await c.query(`DELETE FROM contact_companies WHERE contact_id = $1 AND source = 'sync'`, [contactId]);
  }
  await repinPrimary(c, contactId);
}

/** Ensure the contact has exactly one primary membership when it has any (keeping the current one
 *  if it survived, else the oldest), and mirror it onto contacts.company_id / contacts.company. */
export async function repinPrimary(c: PoolClient, contactId: string): Promise<void> {
  const cur = await c.query(`SELECT company_id FROM contact_companies WHERE contact_id = $1 AND is_primary`, [contactId]);
  let primary = cur.rows[0]?.company_id as string | undefined;
  if (!primary) {
    primary = (await c.query(
      `SELECT company_id FROM contact_companies WHERE contact_id = $1 ORDER BY created_at, company_id LIMIT 1`, [contactId],
    )).rows[0]?.company_id as string | undefined;
    if (primary) {
      await c.query(`UPDATE contact_companies SET is_primary = true WHERE contact_id = $1 AND company_id = $2`, [contactId, primary]);
    }
  }
  await c.query(
    `UPDATE contacts SET company_id = $2,
            company = COALESCE((SELECT name FROM companies WHERE id = $2), '')
      WHERE id = $1 AND company_id IS DISTINCT FROM $2`,
    [contactId, primary ?? null],
  );
}

export type TopicOutcome = { status: "ok"; topics: { id: string; name: string; subscribed: boolean }[] } | { status: "not_found"; what: "contact" | "topic" };

/** Opt a contact (by external_id) out of / back into one subscription topic
 *  (POST /v1/public/contacts/topics). The topic-level analog of the global subscription call —
 *  a topic opt-out is always the person's preference as mirrored by the system of record, so no
 *  source guard applies; the global opt-out still overrides every topic. */
export async function publicSetTopic(
  tenantId: string,
  externalId: string,
  topicId: string,
  subscribed: boolean,
): Promise<TopicOutcome> {
  return withTenant(tenantId, async (c) => {
    const ct = await c.query(`SELECT id FROM contacts WHERE external_id = $1 LIMIT 1`, [externalId]);
    if (!ct.rowCount) return { status: "not_found", what: "contact" };
    const tp = await c.query(`SELECT 1 FROM subscription_topics WHERE id = $1 AND NOT archived`, [topicId]);
    if (!tp.rowCount) return { status: "not_found", what: "topic" };
    const contactId = ct.rows[0].id as string;
    if (subscribed) {
      await c.query(`DELETE FROM contact_topic_optouts WHERE contact_id = $1 AND topic_id = $2`, [contactId, topicId]);
    } else {
      await c.query(
        `INSERT INTO contact_topic_optouts (tenant_id, contact_id, topic_id) VALUES (current_tenant(), $1, $2)
         ON CONFLICT DO NOTHING`,
        [contactId, topicId],
      );
    }
    const all = await c.query(
      `SELECT t.id, t.name, NOT EXISTS (SELECT 1 FROM contact_topic_optouts o WHERE o.topic_id = t.id AND o.contact_id = $1) AS subscribed
         FROM subscription_topics t WHERE NOT t.archived ORDER BY t.name`,
      [contactId],
    );
    return { status: "ok", topics: all.rows as { id: string; name: string; subscribed: boolean }[] };
  });
}
