import { api } from "@/lib/api";

// Feature-request tracking client. A request accumulates ticket evidence; the evidence count is the
// demand signal used to prioritize the board.

export const FEATURE_STATUSES = ["open", "planned", "in_progress", "shipped", "declined"] as const;
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];

export const STATUS_META: Record<FeatureStatus, { label: string; badge: "default" | "warning" | "muted" | "outline" }> = {
  open: { label: "Open", badge: "outline" },
  planned: { label: "Planned", badge: "default" },
  in_progress: { label: "In progress", badge: "default" },
  shipped: { label: "Shipped", badge: "muted" },
  declined: { label: "Declined", badge: "muted" },
};

export interface FeatureRequest {
  id: string;
  title: string;
  description: string;
  status: FeatureStatus;
  evidence_count: number;
  created_at: string;
  updated_at: string;
}

export interface FeatureRequestDetail extends FeatureRequest {
  tickets: { id: string; subject: string; status: string }[];
}

export async function fetchFeatureRequests(status?: string): Promise<FeatureRequest[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  return (await api<{ requests: FeatureRequest[] }>(`/feature-requests${qs}`)).requests;
}
export async function fetchFeatureRequest(id: string): Promise<FeatureRequestDetail> {
  return (await api<{ request: FeatureRequestDetail }>(`/feature-requests/${id}`)).request;
}
export async function createFeatureRequest(input: { title: string; description?: string; status?: FeatureStatus }): Promise<FeatureRequest> {
  return (await api<{ request: FeatureRequest }>("/feature-requests", { method: "POST", body: JSON.stringify(input) })).request;
}
export async function updateFeatureRequest(id: string, patch: { title?: string; description?: string; status?: FeatureStatus }): Promise<FeatureRequest> {
  return (await api<{ request: FeatureRequest }>(`/feature-requests/${id}`, { method: "PATCH", body: JSON.stringify(patch) })).request;
}
export async function deleteFeatureRequest(id: string): Promise<void> {
  await api(`/feature-requests/${id}`, { method: "DELETE" });
}
export async function linkTicketToFeature(requestId: string, ticketId: string): Promise<void> {
  await api(`/feature-requests/${requestId}/tickets`, { method: "POST", body: JSON.stringify({ ticketId }) });
}
export async function unlinkTicketFromFeature(requestId: string, ticketId: string): Promise<void> {
  await api(`/feature-requests/${requestId}/tickets/${ticketId}`, { method: "DELETE" });
}
/** The feature requests a ticket is linked to (ticket rail). */
export async function fetchTicketFeatures(ticketId: string): Promise<{ id: string; title: string; status: FeatureStatus }[]> {
  return (await api<{ features: { id: string; title: string; status: FeatureStatus }[] }>(`/tickets/${ticketId}/features`)).features;
}
