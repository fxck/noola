import { api } from "@/lib/api";

// CSAT — customer-satisfaction. Submissions arrive via the public API; the app reads the
// latest response per ticket (detail page) and the tenant-wide rollup (analytics).

export interface CsatResponse {
  id: string;
  ticket_id: string;
  rating: number;
  comment: string | null;
  created_at: string;
}

export interface CsatSummary {
  responses: number;
  average: number | null;
  positive: number;
  positivePct: number;
  distribution: { rating: number; count: number }[];
}

export async function fetchTicketCsat(ticketId: string): Promise<CsatResponse | null> {
  return (await api<{ csat: CsatResponse | null }>(`/tickets/${ticketId}/csat`)).csat;
}
