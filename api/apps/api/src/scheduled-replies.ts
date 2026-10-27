import type pg from "pg";
import { relayPool, withTenant } from "@repo/db";
import { sendAgentReply, type AgentReplyRequest } from "./agent-reply.js";
import { addNote } from "./notes.js";
import { emitTicketUpdated } from "./ticket-events.js";

export const MAX_SEND_DELAY_SECONDS = 600;
const MAX_ATTEMPTS = 5;
// A row left in 'sending' this long belongs to a process that died mid-send.
// It is longer than the slowest dispatch, an SMTP send with nodemailer's 10-minute socket timeout.
const STUCK_SENDING_MS = 15 * 60_000;

export interface ScheduledReplyRow {
  tenant_id: string;
  id: string;
  ticket_id: string;
  author_id: string | null;
  author_name: string | null;
  author_email: string | null;
  body: string;
  request: { attachmentIds?: string[]; channel?: string | null; cc?: string[]; attribution?: string | null; noteId?: string };
  source: "composer" | "discord_promote" | "note";
  discord_message_id: string | null;
  send_at: Date;
  status: "scheduled" | "sending" | "sent" | "cancelled" | "failed";
  attempts: number;
  assistant_muted_at: Date | null;
  created_at: Date;
}

/** How a source other than the composer sends and cancels its rows, e.g. the Discord mirror's 📤 promote. */
export interface ScheduledSource {
  deliver(row: ScheduledReplyRow): Promise<{ messageId: string | null; replay?: boolean }>;
  /** Undoes what the source holds for a row that won't be sent, because it was cancelled or failed for good. */
  release?(row: ScheduledReplyRow): Promise<void>;
  /** Finishes a row whose message turned out to be recorded after its sender died. */
  recovered?(row: ScheduledReplyRow, messageId: string): Promise<void>;
}
const testSources = new Map<string, ScheduledSource>();
export function setScheduledSourceForTests(source: ScheduledReplyRow["source"], handler: ScheduledSource | null): void {
  if (handler) testSources.set(source, handler);
  else testSources.delete(source);
}

async function sourceFor(source: ScheduledReplyRow["source"]): Promise<ScheduledSource | null> {
  const override = testSources.get(source);
  if (override) return override;
  // Imported on use, because the mirror imports this module.
  if (source === "discord_promote") return (await import("./discord-mirror.js")).promoteSource;
  if (source === "note") return (await import("./note-actions.js")).noteSource;
  return null;
}

interface Log {
  warn: (obj: unknown, msg?: string) => void;
}

export async function getSendDelay(tenantId: string): Promise<number> {
  const r = await withTenant(tenantId, (c) => c.query<{ send_delay_seconds: number }>("SELECT send_delay_seconds FROM reply_settings"));
  return r.rows[0]?.send_delay_seconds ?? 0;
}

export async function setSendDelay(tenantId: string, seconds: number): Promise<number> {
  const value = Math.max(0, Math.min(MAX_SEND_DELAY_SECONDS, Math.round(seconds)));
  await withTenant(tenantId, (c) =>
    c.query(
      `INSERT INTO reply_settings (tenant_id, send_delay_seconds) VALUES (current_tenant(), $1)
       ON CONFLICT (tenant_id) DO UPDATE SET send_delay_seconds = EXCLUDED.send_delay_seconds, updated_at = now()`,
      [value],
    ),
  );
  return value;
}

/** Tells an open inbox thread to reload, so a scheduled reply appears, counts down and disappears live. */
function emitScheduledUpdate(c: pg.PoolClient, tenantId: string, ticketId: string, scheduledReplyId: string, status: string): Promise<void> {
  return emitTicketUpdated(c, tenantId, ticketId, { scheduledReplyId, status });
}

export interface ScheduleInput {
  ticketId: string;
  body: string;
  request?: ScheduledReplyRow["request"];
  author: AgentReplyRequest["author"];
  source?: ScheduledReplyRow["source"];
  discordMessageId?: string | null;
  /** The composer's double-submit token. A second request with it returns the first scheduled reply. */
  clientMessageId?: string | null;
}

/**
 * Holds a reply for `delaySeconds`. The assistant is muted at once, as a sent reply would mute it,
 * so it doesn't answer the customer while the reply waits.
 * A reply that is cancelled or fails switches it back on (see `unmuteIfUnsent`).
 */
export async function scheduleReply(tenantId: string, input: ScheduleInput, delaySeconds: number): Promise<{ id: string; sendAt: string }> {
  return insertReply(tenantId, input, delaySeconds, false);
}

/**
 * Records a reply as already claimed and sends it at once, so the worker of another process can't take it first.
 * The row still dedupes a second send of the same source.
 */
export async function sendReplyNow(tenantId: string, input: ScheduleInput, log: Log): Promise<{ messageId: string | null; retrying: boolean }> {
  const { id } = await insertReply(tenantId, input, 0, true);
  const r = await withTenant(tenantId, (c) => c.query<ScheduledReplyRow>("SELECT * FROM scheduled_replies WHERE id = $1", [id]));
  // A failed send is already set to retry, and it waits in the thread like any held reply.
  return deliverClaimed(r.rows[0], log).then(
    (out) => ({ messageId: out.messageId, retrying: false }),
    () => ({ messageId: null, retrying: true }),
  );
}

async function insertReply(tenantId: string, input: ScheduleInput, delaySeconds: number, claimed: boolean): Promise<{ id: string; sendAt: string }> {
  return withTenant(tenantId, async (c) => {
    const muted = await c.query("UPDATE tickets SET assistant_enabled = false WHERE id = $1 AND assistant_enabled", [input.ticketId]);
    const r = await c.query<{ id: string; send_at: Date }>(
      `INSERT INTO scheduled_replies
         (tenant_id, ticket_id, author_id, author_name, author_email, body, request, source, discord_message_id, client_message_id, send_at,
          assistant_muted_at, status, attempts)
       VALUES (current_tenant(), $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, now() + make_interval(secs => $10),
               CASE WHEN $11::boolean THEN now() END, CASE WHEN $12::boolean THEN 'sending' ELSE 'scheduled' END, CASE WHEN $12::boolean THEN 1 ELSE 0 END)
       ON CONFLICT (tenant_id, client_message_id) WHERE client_message_id IS NOT NULL DO NOTHING
       RETURNING id, send_at`,
      [
        input.ticketId, input.author.userId, input.author.name, input.author.email, input.body,
        JSON.stringify(input.request ?? {}), input.source ?? "composer", input.discordMessageId ?? null,
        input.clientMessageId ?? null, delaySeconds, (muted.rowCount ?? 0) > 0, claimed,
      ],
    );
    if (!r.rowCount) {
      const first = await c.query<{ id: string; send_at: Date }>("SELECT id, send_at FROM scheduled_replies WHERE client_message_id = $1", [
        input.clientMessageId,
      ]);
      return { id: first.rows[0].id, sendAt: first.rows[0].send_at.toISOString() };
    }
    if (!claimed) await emitScheduledUpdate(c, tenantId, input.ticketId, r.rows[0].id, "scheduled");
    return { id: r.rows[0].id, sendAt: r.rows[0].send_at.toISOString() };
  });
}

export interface ScheduledReplyView {
  id: string;
  body: string;
  sendAt: string;
  status: "scheduled" | "sending";
  source: ScheduledReplyRow["source"];
  authorId: string | null;
  authorName: string | null;
}

/** The ticket's replies that are waiting or being sent, oldest first. */
export async function listOpenScheduledReplies(tenantId: string, ticketId: string): Promise<ScheduledReplyView[]> {
  const r = await withTenant(tenantId, (c) =>
    c.query<ScheduledReplyRow>(
      "SELECT * FROM scheduled_replies WHERE ticket_id = $1 AND status IN ('scheduled', 'sending') ORDER BY send_at ASC",
      [ticketId],
    ),
  );
  return r.rows.map((row) => ({
    id: row.id, body: row.body, sendAt: row.send_at.toISOString(), status: row.status as "scheduled" | "sending",
    source: row.source, authorId: row.author_id, authorName: row.author_name,
  }));
}

/** Cancels a reply that is still waiting. Null when it is already being sent, sent, or gone. */
export async function cancelScheduledReply(tenantId: string, id: string): Promise<ScheduledReplyRow | null> {
  const row = await withTenant(tenantId, async (c) => {
    const r = await c.query<ScheduledReplyRow>(
      "UPDATE scheduled_replies SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status = 'scheduled' RETURNING *",
      [id],
    );
    if (!r.rowCount) return null;
    await unmuteIfUnsent(c, r.rows[0]);
    await emitScheduledUpdate(c, tenantId, r.rows[0].ticket_id, id, "cancelled");
    return r.rows[0];
  });
  if (row) await (await sourceFor(row.source))?.release?.(row).catch(() => {});
  return row;
}

/** Sends a waiting reply now. Null when it is already being sent, sent, cancelled, or gone. */
export async function sendScheduledReplyNow(tenantId: string, id: string, log: Log): Promise<{ messageId: string | null } | null> {
  const r = await withTenant(tenantId, (c) =>
    c.query<ScheduledReplyRow>(
      `UPDATE scheduled_replies SET status = 'sending', attempts = attempts + 1, updated_at = now()
        WHERE id = $1 AND status = 'scheduled' RETURNING *`,
      [id],
    ),
  );
  if (!r.rowCount) return null;
  return deliverClaimed(r.rows[0], log);
}

/** Sends a claimed row. A failure retries with backoff, and the last attempt marks the row failed. */
async function deliverClaimed(row: ScheduledReplyRow, log: Log): Promise<{ messageId: string | null }> {
  await withTenant(row.tenant_id, (c) => emitScheduledUpdate(c, row.tenant_id, row.ticket_id, row.id, "sending")).catch(() => {});
  try {
    const handler = await sourceFor(row.source);
    if (!handler && row.source !== "composer") throw new Error(`no sender for ${row.source}`);
    const out = handler
      ? await handler.deliver(row)
      : await sendAgentReply(
          row.tenant_id,
          {
            ticketId: row.ticket_id,
            body: row.body,
            attachmentIds: row.request.attachmentIds,
            channel: row.request.channel ?? null,
            cc: row.request.cc,
            // A retry after a crash finds the message already recorded and doesn't send it twice.
            idempotencyKey: `scheduled:${row.id}`,
            author: { userId: row.author_id, name: row.author_name, email: row.author_email },
          },
          log,
        );
    if ("replay" in out && out.replay) log.warn({ scheduledReplyId: row.id }, "scheduled reply was already recorded, so it was not sent again");
    await withTenant(row.tenant_id, async (c) => {
      // The attempt fences the write, so a claim that was reset and taken again doesn't get overwritten.
      await c.query(
        "UPDATE scheduled_replies SET status = 'sent', message_id = $2, last_error = NULL, updated_at = now() WHERE id = $1 AND status = 'sending' AND attempts = $3",
        [row.id, out.messageId, row.attempts],
      );
      await emitScheduledUpdate(c, row.tenant_id, row.ticket_id, row.id, "sent");
    });
    return { messageId: out.messageId };
  } catch (err) {
    const failed = row.attempts >= MAX_ATTEMPTS;
    log.warn({ err, scheduledReplyId: row.id, attempt: row.attempts }, failed ? "scheduled reply failed for good" : "scheduled reply failed, retrying");
    const updated = await withTenant(row.tenant_id, async (c) => {
      const u = await c.query<ScheduledReplyRow>(
        `UPDATE scheduled_replies
            SET status = $2, last_error = $3, send_at = now() + make_interval(secs => $4), updated_at = now()
          WHERE id = $1 AND status = 'sending' AND attempts = $5
          RETURNING *`,
        [row.id, failed ? "failed" : "scheduled", String((err as Error)?.message ?? err).slice(0, 500), 30 * row.attempts, row.attempts],
      );
      if (!u.rowCount) return false;
      // The fresh row, since a cancelled sibling may have handed this one the mute while it was sending.
      if (failed) await unmuteIfUnsent(c, u.rows[0]);
      await emitScheduledUpdate(c, row.tenant_id, row.ticket_id, row.id, failed ? "failed" : "scheduled");
      return true;
    }).catch(() => false);
    // The pending reply leaves the thread, so a note keeps its text and says it was not sent.
    if (failed && updated) {
      await (await sourceFor(row.source))?.release?.(row).catch(() => {});
      await addNote(row.tenant_id, row.ticket_id, {
        authorId: row.author_id,
        authorName: row.author_name,
        body: `This reply couldn't be sent and was not delivered to the customer:\n\n${row.body}`,
      }).catch((noteErr) => log.warn({ err: noteErr, scheduledReplyId: row.id }, "failed-reply note not added"));
    }
    throw err;
  }
}

/**
 * Switches the assistant back on when this reply switched it off and no agent has replied since.
 * While another reply still waits, that reply takes over the job, so the last one that is never sent switches it on.
 */
async function unmuteIfUnsent(c: pg.PoolClient, row: ScheduledReplyRow): Promise<void> {
  if (!row.assistant_muted_at) return;
  // The status is checked again outside the subquery, so a sibling that is cancelled at the same moment can't receive it.
  // The later of the two times wins, because a mute after a manual re-enable is the newer decision.
  const handedOver = await c.query(
    `UPDATE scheduled_replies SET assistant_muted_at = GREATEST(assistant_muted_at, $3)
      WHERE id = (SELECT id FROM scheduled_replies
                   WHERE ticket_id = $1 AND id <> $2 AND status IN ('scheduled', 'sending')
                   ORDER BY created_at LIMIT 1
                   FOR UPDATE SKIP LOCKED)
        AND status IN ('scheduled', 'sending')`,
    [row.ticket_id, row.id, row.assistant_muted_at],
  );
  if (handedOver.rowCount) return;
  await c.query(
    `UPDATE tickets SET assistant_enabled = true
      WHERE id = $1 AND NOT assistant_enabled
        AND NOT EXISTS (SELECT 1 FROM messages WHERE ticket_id = $1 AND author_type = 'agent' AND created_at > $2)`,
    [row.ticket_id, row.assistant_muted_at],
  );
}

/**
 * Settles rows left in 'sending' by a process that died. A row whose message is recorded was sent, possibly to the
 * customer too, so it is marked sent and must not be cancelled or sent again. Any other row waits for another attempt.
 */
async function settleStuckRows(log: Log): Promise<void> {
  const settled = await relayPool.query<ScheduledReplyRow & { found_message_id: string | null }>(
    `WITH stuck AS (
       SELECT s.tenant_id, s.id,
              (SELECT m.id FROM messages m
                WHERE m.tenant_id = s.tenant_id
                  AND m.idempotency_key = CASE s.source
                                            WHEN 'discord_promote' THEN 'discord-mirror-promote:' || s.discord_message_id
                                            WHEN 'note' THEN 'note:' || (s.request->>'noteId')
                                            ELSE 'scheduled:' || s.id END) AS found_message_id
         FROM scheduled_replies s
        WHERE s.status = 'sending' AND s.updated_at < now() - make_interval(secs => $1)
        FOR UPDATE SKIP LOCKED)
     UPDATE scheduled_replies s
        SET status = CASE WHEN stuck.found_message_id IS NULL THEN 'scheduled' ELSE 'sent' END,
            message_id = stuck.found_message_id,
            updated_at = now()
       FROM stuck
      WHERE s.tenant_id = stuck.tenant_id AND s.id = stuck.id
     RETURNING s.*, stuck.found_message_id`,
    [STUCK_SENDING_MS / 1000],
  );
  for (const row of settled.rows) {
    if (row.found_message_id) {
      await (await sourceFor(row.source))?.recovered?.(row, row.found_message_id)
        .catch((err) => log.warn({ err, scheduledReplyId: row.id }, "recovered scheduled reply not finished"));
    }
    await withTenant(row.tenant_id, (c) => emitScheduledUpdate(c, row.tenant_id, row.ticket_id, row.id, row.status)).catch(() => {});
  }
}

let draining = false;

/** Sends due replies of every tenant. Each api process runs it, and a row is claimed by one of them. */
export async function drainScheduledReplies(log: Log): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    await settleStuckRows(log);
    const claimed = await relayPool.query<ScheduledReplyRow>(
      `UPDATE scheduled_replies s SET status = 'sending', attempts = s.attempts + 1, updated_at = now()
        WHERE (s.tenant_id, s.id) IN (
          SELECT tenant_id, id FROM scheduled_replies
           WHERE status = 'scheduled' AND send_at <= now()
           ORDER BY send_at
           FOR UPDATE SKIP LOCKED
           LIMIT 20)
      RETURNING s.*`,
    );
    for (const row of claimed.rows) await deliverClaimed(row, log).catch(() => {});
  } finally {
    draining = false;
  }
}
