import { withTenant } from "@repo/db";
import { upsertContact } from "./contacts.js";

// Wave 5: custom data events — the per-contact activity timeline. A named event with optional JSON
// metadata, attributed to a contact. Complements contacts.attributes (the custom-data ATTRIBUTES):
// attributes are the current state, events are the history. Ingested via the authed API (by contact
// id) and a public api-key lane (by external_id/email, which upserts the contact first).

export interface ContactEventRow {
  id: string;
  contact_id: string;
  name: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

/** Record an event against a known contact id. Returns null if the contact doesn't exist (FK). */
export async function recordContactEvent(
  tenantId: string,
  contactId: string,
  name: string,
  metadata?: Record<string, unknown>,
): Promise<ContactEventRow | null> {
  try {
    return await withTenant(tenantId, async (c) => {
      const r = await c.query(
        `INSERT INTO contact_events (tenant_id, contact_id, name, metadata)
           VALUES (current_tenant(), $1, $2, COALESCE($3,'{}'::jsonb))
         RETURNING id, contact_id, name, metadata, created_at`,
        [contactId, name.trim(), metadata ? JSON.stringify(metadata) : null],
      );
      return mapRow(r.rows[0]);
    });
  } catch (e) {
    // 23503 = FK violation (unknown contact) → surface as null, not a 500.
    if ((e as { code?: string }).code === "23503") return null;
    throw e;
  }
}

/** The newest-first event timeline for a contact (bounded). */
export async function listContactEvents(
  tenantId: string,
  contactId: string,
  limit = 100,
): Promise<ContactEventRow[]> {
  const cap = Math.min(Math.max(limit, 1), 500);
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT id, contact_id, name, metadata, created_at
         FROM contact_events
        WHERE contact_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [contactId, cap],
    );
    return r.rows.map(mapRow);
  });
}

/**
 * Track an event by contact identity (external_id or email) — the public-API shape. Upserts the
 * contact first (so a `track` call from an app that has never synced the profile still lands), then
 * records the event. Returns the created event, or null when neither identifier was supplied.
 */
export async function trackEvent(
  tenantId: string,
  input: { externalId?: string; email?: string; name: string; metadata?: Record<string, unknown> },
): Promise<ContactEventRow | null> {
  if (!input.externalId && !input.email) return null;
  const { contact } = await upsertContact(tenantId, {
    external_id: input.externalId,
    email: input.email,
  });
  return recordContactEvent(tenantId, contact.id, input.name, input.metadata);
}

function mapRow(row: Record<string, unknown>): ContactEventRow {
  return {
    id: row.id as string,
    contact_id: row.contact_id as string,
    name: row.name as string,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    created_at: (row.created_at as Date).toISOString(),
  };
}
