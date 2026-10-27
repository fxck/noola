import { withTenant } from "@repo/db";
import { setNoteBody } from "./notes.js";
import { sendAgentReply } from "./agent-reply.js";
import { deleteObject } from "./storage.js";
import { emitTicketUpdated } from "./ticket-events.js";
import { roleAtLeast } from "./rbac.js";
import {
  cancelScheduledReply, getSendDelay, scheduleReply, sendReplyNow, type ScheduledReplyRow, type ScheduledSource,
} from "./scheduled-replies.js";
import {
  deleteDiscordNoteMessage, discordNoteOrigins, promoteMirrorNote, relayNoteEditToMirror, removeNoteCopies,
  setPendingReaction,
} from "./discord-mirror.js";

// Editing, deleting and sending internal notes, kept in step with the bot's copy in the Discord mirror thread.

export interface NoteActor {
  userId: string | null;
  name: string | null;
  email: string | null;
  role?: string | null;
}

interface NoteRecord {
  id: string;
  ticket_id: string;
  author_id: string | null;
  body: string;
}

async function loadNote(tenantId: string, noteId: string): Promise<NoteRecord | null> {
  const r = await withTenant(tenantId, (c) => c.query<NoteRecord>("SELECT id, ticket_id, author_id, body FROM ticket_notes WHERE id = $1", [noteId]));
  return r.rows[0] ?? null;
}

/** A send of this note that is waiting or under way, if any. */
async function pendingSend(tenantId: string, noteId: string): Promise<{ id: string } | null> {
  const r = await withTenant(tenantId, (c) =>
    c.query<{ id: string }>(
      "SELECT id FROM scheduled_replies WHERE source = 'note' AND request->>'noteId' = $1 AND status IN ('scheduled', 'sending') LIMIT 1",
      [noteId],
    ),
  );
  return r.rows[0] ?? null;
}

export type NoteActionResult =
  | { ok: true }
  | { ok: false; code: 403 | 404 | 409 | 503; error: string; detail: string };

const notFound: NoteActionResult = { ok: false, code: 404, error: "not_found", detail: "This note no longer exists." };

/**
 * Changes a note's text. Only its author may, and only for a note written in Noola, because the bot
 * can't edit a teammate's Discord message.
 */
export async function editNote(tenantId: string, noteId: string, actor: NoteActor, body: string): Promise<NoteActionResult> {
  const note = await loadNote(tenantId, noteId);
  if (!note) return notFound;
  if (!actor.userId || note.author_id !== actor.userId) {
    return { ok: false, code: 403, error: "not_author", detail: "Only the person who wrote this note can edit it." };
  }
  if ((await discordNoteOrigins([noteId])).size) {
    return { ok: false, code: 409, error: "written_in_discord", detail: "This note was written in Discord. Edit the message there." };
  }
  if (await pendingSend(tenantId, noteId)) {
    return { ok: false, code: 409, error: "send_pending", detail: "This note is about to be sent. Cancel the send to edit it." };
  }
  const edited = await setNoteBody(tenantId, noteId, body);
  if (!edited) return notFound;
  await relayNoteEditToMirror(tenantId, note.ticket_id, noteId, edited.editedAt).catch(() => {});
  return { ok: true };
}

/**
 * Deletes a note for its author or an admin. A note written in Discord goes only when the bot can
 * delete the teammate's message too, so the two stay the same.
 */
export async function removeNote(tenantId: string, noteId: string, actor: NoteActor): Promise<NoteActionResult> {
  const note = await loadNote(tenantId, noteId);
  if (!note) return notFound;
  const isAuthor = Boolean(actor.userId) && note.author_id === actor.userId;
  if (!isAuthor && !roleAtLeast(actor.role, "admin")) {
    return { ok: false, code: 403, error: "not_allowed", detail: "Only the person who wrote this note or an admin can delete it." };
  }
  const origin = (await discordNoteOrigins([noteId])).get(noteId);
  if (origin) {
    // A 📤 promote of it that still waits is cancelled first, so it can't send what was deleted.
    const promote = await withTenant(tenantId, (c) =>
      c.query<{ id: string }>("SELECT id FROM scheduled_replies WHERE discord_message_id = $1 AND status = 'scheduled'", [origin.discordMessageId]),
    );
    if (promote.rowCount) await cancelScheduledReply(tenantId, promote.rows[0].id);
    const deleted = await deleteDiscordNoteMessage(origin);
    if (deleted === "forbidden") {
      return {
        ok: false, code: 409, error: "discord_forbidden",
        detail: "The bot isn't allowed to delete that Discord message. Give it Manage Messages in the forum, or delete the message in Discord.",
      };
    }
    if (deleted === "unavailable") {
      return { ok: false, code: 503, error: "discord_unavailable", detail: "Discord can't be reached right now, so the note was kept. Try again shortly." };
    }
  }
  await purgeNote(tenantId, note.ticket_id, noteId);
  return { ok: true };
}

/** Removes a note with its files, its Discord copy and any send of it that is still waiting. */
export async function purgeNote(tenantId: string, ticketId: string, noteId: string): Promise<void> {
  const waiting = await pendingSend(tenantId, noteId);
  if (waiting) await cancelScheduledReply(tenantId, waiting.id).catch(() => null);
  await removeNoteCopies(tenantId, ticketId, noteId).catch(() => {});
  const keys = await withTenant(tenantId, async (c) => {
    const files = await c.query<{ storage_key: string | null }>(
      "DELETE FROM message_attachments WHERE note_id = $1 AND message_id IS NULL RETURNING storage_key",
      [noteId],
    );
    const gone = await c.query("DELETE FROM ticket_notes WHERE id = $1", [noteId]);
    if (gone.rowCount) await emitTicketUpdated(c, tenantId, ticketId, { noteId, change: "deleted" });
    return files.rows.map((f) => f.storage_key).filter((k): k is string => Boolean(k));
  });
  for (const key of keys) await deleteObject(key).catch(() => {});
}

export type SendNoteResult =
  | { status: "sent" | "scheduled" }
  | { status: "not_found" | "already_sending" | "not_promotable" };

/**
 * Sends a note to the customer as a reply, after the workspace's send delay. A note written in Discord
 * goes through the 📤 promote, so Discord shows ⏳ and ✅. Any other note is sent as the actor's reply,
 * with its files, and then removed with its Discord copy.
 */
export async function sendNoteToCustomer(
  tenantId: string,
  noteId: string,
  actor: NoteActor,
  opts: { sendNow?: boolean; discordCopy?: { threadId: string; discordMessageId: string }; log?: { warn: (obj: unknown, msg?: string) => void } } = {},
): Promise<SendNoteResult> {
  const note = await loadNote(tenantId, noteId);
  if (!note) return { status: "not_found" };
  if (await discordNoteOrigins([noteId]).then((m) => m.size > 0)) {
    const promoted = await promoteMirrorNote(tenantId, noteId, actor.userId, opts.sendNow === true);
    return promoted === "scheduled" || promoted === "sent" ? { status: promoted } : { status: "not_promotable" };
  }
  if (await pendingSend(tenantId, noteId)) return { status: "already_sending" };
  const delay = opts.sendNow ? 0 : await getSendDelay(tenantId);
  const attachmentIds = await noteAttachmentIds(tenantId, noteId);
  const input = {
    ticketId: note.ticket_id,
    body: note.body,
    request: { noteId, attachmentIds },
    author: { userId: actor.userId, name: actor.name, email: actor.email },
    source: "note" as const,
    discordMessageId: opts.discordCopy?.discordMessageId ?? null,
  };
  // The row is also the claim, so a second click or 📤 can't send the note twice.
  const taken = (err: { code?: string }) => {
    if (err.code === "23505") return null;
    throw err;
  };
  if (delay === 0) {
    const sent = await sendReplyNow(tenantId, input, opts.log ?? console).catch(taken);
    if (!sent) return { status: "already_sending" };
    return { status: sent.retrying ? "scheduled" : "sent" };
  }
  const scheduled = await scheduleReply(tenantId, input, delay).catch(taken);
  if (!scheduled) return { status: "already_sending" };
  if (opts.discordCopy) await setPendingReaction(tenantId, note.ticket_id, opts.discordCopy, true).catch(() => {});
  return { status: "scheduled" };
}

async function noteAttachmentIds(tenantId: string, noteId: string): Promise<string[]> {
  const r = await withTenant(tenantId, (c) => c.query<{ id: string }>("SELECT id FROM message_attachments WHERE note_id = $1", [noteId]));
  return r.rows.map((x) => x.id);
}

/** Sends the scheduled rows of notes. The note stays until its reply is recorded, so a cancelled send keeps it. */
export const noteSource: ScheduledSource = {
  async deliver(row: ScheduledReplyRow) {
    const noteId = row.request.noteId!;
    const sent = await sendAgentReply(
      row.tenant_id,
      {
        ticketId: row.ticket_id,
        body: row.body,
        attachmentIds: row.request.attachmentIds,
        // A retry after a crash finds the reply recorded and doesn't send it twice.
        idempotencyKey: `note:${noteId}`,
        author: { userId: row.author_id, name: row.author_name, email: row.author_email },
      },
      console,
    );
    await purgeNote(row.tenant_id, row.ticket_id, noteId);
    return { messageId: sent.messageId, replay: sent.replay };
  },
  async release(row: ScheduledReplyRow) {
    if (!row.discord_message_id) return;
    const { threadOfNoteCopy } = await import("./discord-mirror.js");
    const threadId = await threadOfNoteCopy(row.discord_message_id);
    if (threadId) await setPendingReaction(row.tenant_id, row.ticket_id, { threadId, discordMessageId: row.discord_message_id }, false);
  },
  async recovered(row: ScheduledReplyRow) {
    if (row.request.noteId) await purgeNote(row.tenant_id, row.ticket_id, row.request.noteId);
  },
};
