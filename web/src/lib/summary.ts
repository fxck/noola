import { api } from "./api";

export interface TicketSummary {
  summary: string;
  model: string;
}

/** Auto-summarize a ticket's thread into an agent-facing wrap-up (handoff / triage). */
export async function summarizeTicket(ticketId: string): Promise<TicketSummary> {
  return api(`/tickets/${ticketId}/summarize`, { method: "POST" });
}
