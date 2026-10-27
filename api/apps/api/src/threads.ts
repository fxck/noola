import { withTenant, relayPool } from "@repo/db";
import {
  ensureThreadsCollection,
  indexThreadDoc,
  deleteThreadDoc,
  searchThreadIds,
} from "./search.js";
import { embeddingDriver } from "./model.js";
import { upsertVectors, deleteVectors } from "./vector.js";

// Resolved threads as a knowledge source. When a ticket is closed, its thread
// (subject + the Q&A exchange) becomes retrievable so Copilot can reuse how the
// team already answered a similar question — the same extract→index→retrieve shape
// as documents, but the "document" is a past conversation we already own (no
// upload, no external connector). Reopening a ticket removes it from the source.

export { ensureThreadsCollection };

export interface ThreadHit {
  ticket_id: string;
  subject: string;
  text: string; // full thread text (grounding)
  snippet: string;
}

interface ThreadMessage {
  author_type: string;
  body: string;
}

/** Render a thread as plain text: subject first, then each turn labelled by role. */
function threadText(subject: string, messages: ThreadMessage[]): string {
  const turns = messages.map((m) => `${m.author_type === "agent" ? "Agent" : "Customer"}: ${m.body}`);
  return [subject, ...turns].join("\n");
}

/**
 * Index a resolved ticket's thread as a knowledge source. No-op unless the ticket
 * is actually closed (open tickets aren't "resolved knowledge"). Reads through RLS.
 */
export async function indexResolvedThread(tenantId: string, ticketId: string): Promise<void> {
  const data = await withTenant(tenantId, async (c) => {
    const t = await c.query(
      "SELECT subject, extract(epoch FROM closed_at)::bigint AS closed_at FROM tickets WHERE id = $1 AND status = 'closed'",
      [ticketId],
    );
    if (!t.rowCount) return null;
    const m = await c.query(
      "SELECT author_type, body FROM messages WHERE ticket_id = $1 ORDER BY created_at ASC",
      [ticketId],
    );
    return {
      subject: t.rows[0].subject as string,
      closed_at: Number(t.rows[0].closed_at) || 0,
      messages: m.rows as ThreadMessage[],
    };
  });
  if (!data) return;
  const text = threadText(data.subject, data.messages);
  await indexThreadDoc({
    id: ticketId,
    tenant_id: tenantId,
    subject: data.subject,
    text,
    closed_at: data.closed_at,
  });
  const vecs = await embeddingDriver.embed([text]);
  if (vecs) await upsertVectors("threads", [{ id: ticketId, vector: vecs[0], payload: { tenant_id: tenantId } }]);
}

/** Drop a thread from the source indexes (ticket reopened or deleted). */
export async function unindexThread(ticketId: string): Promise<void> {
  await deleteThreadDoc(ticketId);
  await deleteVectors("threads", [ticketId]);
}

/** Hydrate resolved-thread ids through RLS (still-closed only) into full ThreadHits,
 *  preserving the given id order (double tenant guard for either ranker). */
export async function hydrateThreads(tenantId: string, ids: string[]): Promise<ThreadHit[]> {
  if (ids.length === 0) return [];
  return withTenant(tenantId, async (c) => {
    const t = await c.query(
      "SELECT id, subject FROM tickets WHERE id = ANY($1::uuid[]) AND status = 'closed'",
      [ids],
    );
    const subjects = new Map<string, string>(t.rows.map((r) => [r.id as string, r.subject as string]));
    const hits: ThreadHit[] = [];
    for (const id of ids) {
      const subject = subjects.get(id);
      if (!subject) continue; // RLS / status guard dropped it
      const m = await c.query(
        "SELECT author_type, body FROM messages WHERE ticket_id = $1 ORDER BY created_at ASC",
        [id],
      );
      const text = threadText(subject, m.rows as ThreadMessage[]);
      hits.push({ ticket_id: id, subject, text, snippet: text.slice(0, 180) });
    }
    return hits;
  });
}

/**
 * Retrieve resolved threads relevant to a query. Typesense ranks (tenant filter_by),
 * rows hydrate through RLS re-reading only still-closed tickets (double tenant guard,
 * and drops any thread reopened since it was indexed).
 */
export async function searchResolvedThreads(tenantId: string, q: string): Promise<ThreadHit[]> {
  return hydrateThreads(tenantId, await searchThreadIds(tenantId, q));
}

/** Backfill: index every already-closed ticket. System-level read via the BYPASSRLS
 *  relay; each doc still carries its tenant_id for query-time isolation. */
export async function reindexAllThreads(
  log?: { info: (m: string) => void; warn: (o: unknown, m?: string) => void },
): Promise<number> {
  const r = await relayPool.query(
    `SELECT t.tenant_id, t.id, t.subject,
            coalesce(
              string_agg(
                (CASE WHEN m.author_type = 'agent' THEN 'Agent: ' ELSE 'Customer: ' END || m.body),
                E'\n' ORDER BY m.created_at
              ), '') AS turns,
            extract(epoch FROM t.closed_at)::bigint AS closed_at
       FROM tickets t
       LEFT JOIN messages m ON m.tenant_id = t.tenant_id AND m.ticket_id = t.id
      WHERE t.status = 'closed'
      GROUP BY t.tenant_id, t.id, t.subject, t.closed_at`,
  );
  let n = 0;
  for (const row of r.rows as Array<{ tenant_id: string; id: string; subject: string; turns: string; closed_at: string | number }>) {
    try {
      await indexThreadDoc({
        id: row.id,
        tenant_id: row.tenant_id,
        subject: row.subject,
        text: row.turns ? `${row.subject}\n${row.turns}` : row.subject,
        closed_at: Number(row.closed_at) || 0,
      });
      n++;
    } catch (err) {
      log?.warn?.({ err, id: row.id }, "reindex thread failed");
    }
  }
  log?.info?.(`search: reindexed ${n} resolved threads`);
  return n;
}
