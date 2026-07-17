import { api } from "@/lib/api";

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
): Promise<Note> {
  return (
    await api<{ note: Note }>(`/tickets/${ticketId}/notes`, {
      method: "POST",
      body: JSON.stringify({ body, mentionIds: mentionIds ?? [] }),
    })
  ).note;
}

export async function deleteNote(ticketId: string, noteId: string): Promise<void> {
  await api<{ ok: true }>(`/tickets/${ticketId}/notes/${noteId}`, { method: "DELETE" });
}
