import { api } from "./api";

export interface LinkedTicket {
  id: string;
  subject: string;
  status: string;
  relation: string;
  created_at: string;
}

export async function fetchLinks(ticketId: string): Promise<LinkedTicket[]> {
  return (await api<{ links: LinkedTicket[] }>(`/tickets/${ticketId}/links`)).links;
}

export async function linkTicket(ticketId: string, linkedId: string, relation?: string): Promise<{ ok: true; created: boolean }> {
  return api(`/tickets/${ticketId}/links`, { method: "POST", body: JSON.stringify({ linkedId, relation }) });
}

export async function unlinkTicket(ticketId: string, linkedId: string): Promise<{ ok: true }> {
  return api(`/tickets/${ticketId}/links/${linkedId}`, { method: "DELETE" });
}
