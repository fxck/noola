import { withTenant } from "@repo/db";
import { EVENT_TYPES } from "@repo/contracts";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

// Ticket participants — named teammates on a single conversation ("attendees"), alongside the one
// assignee and the team lane. Add drags a teammate into THIS issue; they surface in the context rail
// and (when their Discord id is mapped) get an @ping in the ops mirror. See discord-mirror
// pingSeatInMirror for the notification side.

/** Publish a participant.changed event to the transactional outbox on the SAME connection/txn as the
 *  roster write (message.created's sibling — see ingest.ts / notes.ts). The edge relays it on
 *  noola.events.<tenant>; the web's Participants panel refetches for this ticket. Without this, a
 *  loop-in only surfaced to OTHER agents after a manual refresh. */
async function emitParticipantChanged(
  c: PoolClient,
  tenantId: string,
  ticketId: string,
  userId: string,
  action: "added" | "removed",
): Promise<void> {
  const id = randomUUID();
  const envelope = {
    id,
    type: EVENT_TYPES.participantChanged,
    tenantId,
    ticketId,
    occurredAt: new Date().toISOString(),
    data: { ticketId, userId, action },
  };
  await c.query(
    "INSERT INTO outbox (tenant_id, event_type, subject, payload) VALUES (current_tenant(), $1, 'noola.events.' || current_tenant(), $2::jsonb)",
    [EVENT_TYPES.participantChanged, JSON.stringify(envelope)],
  );
}

export interface Participant {
  userId: string;
  name: string | null;
  avatarUrl: string | null;
}

const SELECT = `SELECT p.user_id, u.name, u.avatar_url
                  FROM ticket_participants p
                  JOIN users u ON u.tenant_id = p.tenant_id AND u.id = p.user_id
                 WHERE p.ticket_id = $1
                 ORDER BY p.created_at ASC`;

function rowToParticipant(x: Record<string, unknown>): Participant {
  return { userId: x.user_id as string, name: (x.name as string | null) ?? null, avatarUrl: (x.avatar_url as string | null) ?? null };
}

/** The teammates participating in a ticket (name + avatar for the rail), oldest-added first. */
export async function listParticipants(tenantId: string, ticketId: string): Promise<Participant[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(SELECT, [ticketId]);
    return r.rows.map(rowToParticipant);
  });
}

/** Add a teammate to a ticket (idempotent). Returns the participant row, or null when the ticket or
 *  user doesn't exist in this tenant (FK violation). `added` is false when they were already on it. */
export async function addParticipant(
  tenantId: string,
  ticketId: string,
  userId: string,
): Promise<{ participant: Participant; added: boolean } | null> {
  return withTenant(tenantId, async (c) => {
    let added = false;
    try {
      const ins = await c.query(
        `INSERT INTO ticket_participants (tenant_id, ticket_id, user_id)
           VALUES (current_tenant(), $1, $2)
         ON CONFLICT (tenant_id, ticket_id, user_id) DO NOTHING`,
        [ticketId, userId],
      );
      added = (ins.rowCount ?? 0) > 0;
    } catch (e) {
      if ((e as { code?: string }).code === "23503") return null; // unknown ticket/user in this tenant
      throw e;
    }
    const r = await c.query(
      `SELECT u.id AS user_id, u.name, u.avatar_url FROM users u WHERE u.id = $1`,
      [userId],
    );
    if (!r.rowCount) return null;
    if (added) await emitParticipantChanged(c, tenantId, ticketId, userId, "added");
    return { participant: rowToParticipant(r.rows[0]), added };
  });
}

/** Remove a teammate from a ticket. */
export async function removeParticipant(tenantId: string, ticketId: string, userId: string): Promise<boolean> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      "DELETE FROM ticket_participants WHERE ticket_id = $1 AND user_id = $2",
      [ticketId, userId],
    );
    const removed = (r.rowCount ?? 0) > 0;
    if (removed) await emitParticipantChanged(c, tenantId, ticketId, userId, "removed");
    return removed;
  });
}
