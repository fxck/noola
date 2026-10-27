import { api, type ApiError } from "@/lib/api";
import type { Attachment } from "@/lib/tickets";

// Internal notes / side conversations — agent-only annotations on a ticket, never
// dispatched to a channel. Interleaved into the thread by created_at, client-side.

export interface Note {
  id: string;
  ticket_id: string;
  author_id: string | null;
  author_name: string | null;
  body: string;
  mentioned_ids: string[];
  mentioned_names: string[];
  created_at: string;
  edited_at: string | null;
  /** Files attached to the note (e.g. a screenshot posted in a Discord mirror thread). */
  attachments?: Attachment[];
  /** "discord" when a teammate wrote it in the Discord mirror thread, so only Discord can edit it. */
  origin: "noola" | "discord";
  /** A send of the note to the customer is waiting or under way. */
  sending: boolean;
}

export async function fetchNotes(ticketId: string): Promise<Note[]> {
  return (await api<{ notes: Note[] }>(`/tickets/${ticketId}/notes`)).notes;
}

/** Add an internal note. `mentionIds` are the member ids from the composer's mention
 *  chips — authoritative when present; the server falls back to parsing @names otherwise. */
export async function addNote(
  ticketId: string,
  body: string,
  mentionIds?: string[],
  attachmentIds?: string[],
): Promise<void> {
  await api<{ note: unknown }>(`/tickets/${ticketId}/notes`, {
    method: "POST",
    body: JSON.stringify({ body, mentionIds: mentionIds ?? [], attachmentIds: attachmentIds ?? [] }),
  });
}

export async function editNote(ticketId: string, noteId: string, body: string): Promise<void> {
  await api<{ ok: true }>(`/tickets/${ticketId}/notes/${noteId}`, {
    method: "PATCH",
    body: JSON.stringify({ body }),
  });
}

export async function deleteNote(ticketId: string, noteId: string): Promise<void> {
  await api<{ ok: true }>(`/tickets/${ticketId}/notes/${noteId}`, { method: "DELETE" });
}

/** "scheduled" when the workspace send delay holds the reply, "sent" when it went out at once. */
export async function sendNoteToCustomer(ticketId: string, noteId: string, sendNow?: boolean): Promise<"scheduled" | "sent"> {
  return (
    await api<{ status: "scheduled" | "sent" }>(`/tickets/${ticketId}/notes/${noteId}/send`, {
      method: "POST",
      body: JSON.stringify({ sendNow }),
    })
  ).status;
}

// The api client keeps only the server's `error` code, so the sentences for each code live here.
const NOTE_ERRORS: Record<string, string> = {
  not_found: "This note no longer exists.",
  not_author: "Only the person who wrote this note can edit it.",
  written_in_discord: "This note was written in Discord. Edit the message there.",
  send_pending: "This note is about to be sent. Cancel the send to edit it.",
  not_allowed: "Only the person who wrote this note or an admin can delete it.",
  discord_forbidden:
    "The bot isn't allowed to delete that Discord message. Give it Manage Messages in the forum, or delete the message in Discord.",
  discord_unavailable: "Discord can't be reached right now, so the note was kept. Try again shortly.",
  already_sending: "This note is already being sent.",
  not_promotable: "This note is already being sent.",
};

export function noteErrorMessage(err: unknown, fallback: string): string {
  const code = (err as ApiError).detail;
  return (code && NOTE_ERRORS[code]) || fallback;
}
