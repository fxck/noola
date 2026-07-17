import { api } from "./api";

export interface ArticleDraft {
  title: string;
  body: string;
  model: string;
}

/** Generate a KB article draft from a resolved ticket's thread (unsaved — the agent reviews). */
export async function draftArticleFromTicket(ticketId: string): Promise<ArticleDraft> {
  return api(`/tickets/${ticketId}/draft-article`, { method: "POST" });
}
