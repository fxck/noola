import { withTenant } from "@repo/db";

// Subscription topics — the multi-level layer over the global marketing opt-out (unsubscribe.ts).
// A topic is a named list a broadcast can be tagged with; a contact opts out per-topic
// (contact_topic_optouts) OR globally (contacts.unsubscribed_at). Suppression at send time is the
// union: global opt-out OR opted out of THIS broadcast's topic OR address-suppressed. The public
// preference center (routes/unsubscribe.ts) reads and writes these per-contact states.

export interface SubscriptionTopic {
  id: string;
  name: string;
  description: string;
  archived: boolean;
  created_at: string;
}

const T_COLS = "id, name, description, archived, created_at";

export async function listTopics(tenantId: string, includeArchived = false): Promise<SubscriptionTopic[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT ${T_COLS} FROM subscription_topics ${includeArchived ? "" : "WHERE archived = false"} ORDER BY archived, name`,
    );
    return r.rows as SubscriptionTopic[];
  });
}

/** Whether a topic id names a live (non-archived) topic for this tenant — the guard broadcast
 *  create/update uses before storing topic_id. */
export async function topicExists(tenantId: string, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  return withTenant(tenantId, async (c) => {
    const r = await c.query("SELECT 1 FROM subscription_topics WHERE id = $1 AND archived = false", [id]);
    return (r.rowCount ?? 0) > 0;
  });
}

export async function createTopic(tenantId: string, input: { name: string; description?: string }): Promise<SubscriptionTopic> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO subscription_topics (name, description) VALUES ($1, $2) RETURNING ${T_COLS}`,
      [input.name.slice(0, 120), (input.description ?? "").slice(0, 400)],
    );
    return r.rows[0] as SubscriptionTopic;
  });
}

export async function updateTopic(
  tenantId: string,
  id: string,
  patch: { name?: string; description?: string; archived?: boolean },
): Promise<SubscriptionTopic | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `UPDATE subscription_topics SET
         name = COALESCE($2, name),
         description = COALESCE($3, description),
         archived = COALESCE($4, archived)
       WHERE id = $1 RETURNING ${T_COLS}`,
      [id, patch.name?.slice(0, 120) ?? null, patch.description?.slice(0, 400) ?? null, patch.archived ?? null],
    );
    return r.rowCount ? (r.rows[0] as SubscriptionTopic) : null;
  });
}

/** Delete a topic. Its opt-out rows go with it (a gone topic can't be opted out of), and any
 *  broadcast that referenced it falls back to an untopiced (global-footer) send. */
export async function deleteTopic(tenantId: string, id: string): Promise<boolean> {
  return withTenant(tenantId, async (c) => {
    await c.query("DELETE FROM contact_topic_optouts WHERE topic_id = $1", [id]);
    await c.query("UPDATE broadcasts SET topic_id = NULL WHERE topic_id = $1", [id]);
    const r = await c.query("DELETE FROM subscription_topics WHERE id = $1", [id]);
    return (r.rowCount ?? 0) > 0;
  });
}

// ---- per-contact subscription state (the preference center) --------------------------------

export interface ContactTopicState {
  id: string;
  name: string;
  description: string;
  subscribed: boolean; // false = this contact opted out of this topic
}

export interface ContactSubscriptionState {
  /** Global opt-out — unsubscribed from EVERYTHING (contacts.unsubscribed_at). Overrides topics. */
  globallyUnsubscribed: boolean;
  topics: ContactTopicState[];
}

/** The full subscription picture for one contact: the global switch + every live topic with this
 *  contact's per-topic state. Powers the preference-center render. */
export async function getContactSubscriptionState(tenantId: string, contactId: string): Promise<ContactSubscriptionState> {
  return withTenant(tenantId, async (c) => {
    const g = await c.query("SELECT unsubscribed_at FROM contacts WHERE id = $1", [contactId]);
    const globallyUnsubscribed = !!g.rows[0]?.unsubscribed_at;
    const t = await c.query(
      `SELECT t.id, t.name, t.description,
              (o.contact_id IS NULL) AS subscribed
         FROM subscription_topics t
         LEFT JOIN contact_topic_optouts o ON o.topic_id = t.id AND o.contact_id = $1
        WHERE t.archived = false
        ORDER BY t.name`,
      [contactId],
    );
    return { globallyUnsubscribed, topics: t.rows as ContactTopicState[] };
  });
}

/** Opt a contact in/out of ONE topic. Idempotent. Returns false only when the contact is gone. */
export async function setTopicOptout(tenantId: string, contactId: string, topicId: string, unsubscribed: boolean): Promise<boolean> {
  if (!isUuid(topicId)) return false;
  return withTenant(tenantId, async (c) => {
    const exists = await c.query("SELECT 1 FROM contacts WHERE id = $1", [contactId]);
    if (!exists.rowCount) return false;
    if (unsubscribed) {
      await c.query(
        "INSERT INTO contact_topic_optouts (contact_id, topic_id) VALUES ($1, $2) ON CONFLICT (tenant_id, contact_id, topic_id) DO NOTHING",
        [contactId, topicId],
      );
    } else {
      await c.query("DELETE FROM contact_topic_optouts WHERE contact_id = $1 AND topic_id = $2", [contactId, topicId]);
    }
    return true;
  });
}

/** True when `s` is a canonical UUID — the guard for a topic id inlined into audience SQL. */
export function isUuid(s: string | null | undefined): boolean {
  return !!s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
