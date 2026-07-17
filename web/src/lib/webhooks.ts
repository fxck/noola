import { api } from "@/lib/api";

// Outbound webhooks client — a tenant registers endpoints that receive event
// callbacks (contact/ticket/message activity). Tenant is server-authoritative
// from the token. The signing secret is returned exactly ONCE, on create, and
// never again — the list shape deliberately omits it. Deliveries are the recent
// per-endpoint attempt log. Every call throws on transport/HTTP error (incl.
// 404) so the page can treat "endpoint not wired yet" as an unavailable state.

/** A registered outbound endpoint. The signing secret is never in this shape —
 *  it's shown once at create time and not stored client-side. */
export interface Webhook {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  created_at: string;
}

/** One delivery attempt against an endpoint (test ping or a real event). Read
 *  loosely — the server may omit fields, so all but the time are optional. */
export interface Delivery {
  /** Which event this delivery carried. Absent for a bare test ping. */
  event?: string | null;
  ok: boolean;
  /** HTTP status the endpoint returned, if it responded at all. */
  status_code?: number | null;
  /** Transport/handshake error when the endpoint couldn't be reached. */
  error?: string | null;
  created_at: string;
}

/** POST body for creating an endpoint. `events`/`active` default server-side. */
export interface WebhookCreateInput {
  url: string;
  events?: string[];
  active?: boolean;
}

/** PATCH body — any subset. Sends only what changed. */
export interface WebhookUpdateInput {
  url?: string;
  events?: string[];
  active?: boolean;
}

/** The event types an endpoint can subscribe to. Defaults to all on create. */
export const EVENT_TYPES = [
  "contact.created",
  "contact.updated",
  "ticket.created",
  "message.created",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** Human labels for the event chips/checkboxes — falls back to the raw id. */
export const EVENT_LABELS: Record<string, string> = {
  "contact.created": "Contact created",
  "contact.updated": "Contact updated",
  "ticket.created": "Ticket created",
  "message.created": "Message created",
};

export async function fetchWebhooks(): Promise<Webhook[]> {
  const r = await api<{ webhooks?: Webhook[] } | Webhook[]>("/webhooks");
  if (Array.isArray(r)) return r;
  return r?.webhooks ?? [];
}

export async function createWebhook(
  input: WebhookCreateInput,
): Promise<{ webhook: Webhook; secret: string }> {
  return api<{ webhook: Webhook; secret: string }>("/webhooks", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateWebhook(
  id: string,
  input: WebhookUpdateInput,
): Promise<Webhook> {
  const r = await api<{ webhook: Webhook } | Webhook>(
    `/webhooks/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
  return "webhook" in r ? r.webhook : r;
}

export async function deleteWebhook(id: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/webhooks/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function testWebhook(id: string): Promise<Delivery> {
  const r = await api<{ delivery: Delivery } | Delivery>(
    `/webhooks/${encodeURIComponent(id)}/test`,
    { method: "POST", body: "{}" },
  );
  return "delivery" in r ? r.delivery : r;
}

export async function fetchDeliveries(id: string): Promise<Delivery[]> {
  const r = await api<{ deliveries?: Delivery[] } | Delivery[]>(
    `/webhooks/${encodeURIComponent(id)}/deliveries`,
  );
  if (Array.isArray(r)) return r;
  return r?.deliveries ?? [];
}
