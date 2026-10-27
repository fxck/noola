import { randomUUID } from "node:crypto";
import type pg from "pg";

/** Tells an open inbox to reload the ticket. Runs in the caller's transaction, so the event is published only if the change commits. */
export async function emitTicketUpdated(c: pg.PoolClient, tenantId: string, ticketId: string, data: Record<string, unknown>): Promise<void> {
  const envelope = { id: randomUUID(), type: "ticket.updated", tenantId, ticketId, occurredAt: new Date().toISOString(), data };
  await c.query(
    "INSERT INTO outbox (tenant_id, event_type, subject, payload) VALUES (current_tenant(), 'ticket.updated', 'noola.events.' || current_tenant(), $1::jsonb)",
    [JSON.stringify(envelope)],
  );
}
