import { withTenant } from "@repo/db";
import type { PoolClient } from "pg";

// Internal notes / side conversations — agent-only annotations on a ticket. NEVER
// dispatched to a channel. Notes can @mention teammates: the mention tokens are resolved
// server-side against tenant member names and stored as `mentioned_ids` (loop-in record).

export interface NoteRow {
  id: string;
  ticket_id: string;
  author_id: string | null;
  author_name: string | null;
  body: string;
  mentioned_ids: string[];
  mentioned_names: string[];
  created_at: string;
}

const COLS = `n.id, n.ticket_id, n.author_id, n.author_name, n.body, n.mentioned_ids, n.created_at,
  COALESCE((SELECT array_agg(u.name ORDER BY u.name) FROM users u WHERE u.id = ANY(n.mentioned_ids)), '{}') AS mentioned_names`;

/** A ticket's internal notes, oldest first (thread order). */
export async function listNotes(tenantId: string, ticketId: string): Promise<NoteRow[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT ${COLS} FROM ticket_notes n WHERE n.ticket_id = $1 ORDER BY n.created_at ASC LIMIT 500`,
      [ticketId],
    );
    return r.rows as NoteRow[];
  });
}

/** Resolve @tokens in the body to member ids (match on full name or first name, case-insensitive). */
async function resolveMentions(c: PoolClient, body: string): Promise<string[]> {
  const tokens = [...body.matchAll(/@([\p{L}][\p{L}'-]*)/gu)].map((m) => m[1].toLowerCase());
  if (tokens.length === 0) return [];
  const r = await c.query(
    `SELECT DISTINCT id FROM users
      WHERE lower(name) = ANY($1::text[]) OR lower(split_part(name, ' ', 1)) = ANY($1::text[])`,
    [Array.from(new Set(tokens))],
  );
  return r.rows.map((x) => x.id as string);
}

/** Keep only ids that are real members of this tenant (RLS scopes `users`, so a
 *  cross-tenant or bogus id simply drops out). Preserves the caller's order, de-dupes. */
async function validateMemberIds(c: PoolClient, ids: string[]): Promise<string[]> {
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) return [];
  const r = await c.query(`SELECT id FROM users WHERE id = ANY($1::uuid[])`, [unique]);
  const live = new Set(r.rows.map((x) => x.id as string));
  return unique.filter((id) => live.has(id));
}

/** Add a note. Returns null if the ticket doesn't exist / isn't visible, so the caller 404s.
 *  `mentionIds` (from the composer's mention chips) is authoritative when present; otherwise
 *  we fall back to parsing @tokens out of the body text. */
export async function addNote(
  tenantId: string,
  ticketId: string,
  input: {
    authorId?: string | null;
    authorName?: string | null;
    body: string;
    mentionIds?: string[];
  },
): Promise<NoteRow | null> {
  return withTenant(tenantId, async (c) => {
    const ok = await c.query(`SELECT 1 FROM tickets WHERE id = $1`, [ticketId]);
    if (!ok.rowCount) return null;
    const explicit = input.mentionIds?.length
      ? await validateMemberIds(c, input.mentionIds)
      : [];
    const mentioned = explicit.length ? explicit : await resolveMentions(c, input.body);
    const ins = await c.query(
      `INSERT INTO ticket_notes (tenant_id, ticket_id, author_id, author_name, body, mentioned_ids)
       VALUES (current_tenant(), $1, $2, $3, $4, $5::uuid[])
       RETURNING id`,
      [ticketId, input.authorId ?? null, input.authorName ?? null, input.body, mentioned],
    );
    // Realtime: publish note.added to the transactional outbox in the SAME txn (message.created's
    // sibling) so the inbox notes panel updates live for every agent. The edge relays it on
    // noola.events.<tenant>; the web refetches the ticket's notes on the event.
    const envelope = {
      id: ins.rows[0].id as string,
      type: "note.added",
      tenantId,
      ticketId,
      occurredAt: new Date().toISOString(),
      data: { noteId: ins.rows[0].id as string, ticketId },
    };
    await c.query(
      "INSERT INTO outbox (tenant_id, event_type, subject, payload) VALUES (current_tenant(), $1, 'noola.events.' || current_tenant(), $2::jsonb)",
      ["note.added", JSON.stringify(envelope)],
    );
    // Re-read on the same connection so mentioned_names hydrate from the just-written ids.
    const r = await c.query(`SELECT ${COLS} FROM ticket_notes n WHERE n.id = $1`, [ins.rows[0].id]);
    return r.rows[0] as NoteRow;
  });
}

export async function deleteNote(tenantId: string, id: string): Promise<boolean> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query("DELETE FROM ticket_notes WHERE id = $1", [id]);
    return (r.rowCount ?? 0) > 0;
  });
}
