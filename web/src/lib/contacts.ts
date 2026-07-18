import { api, API_URL, getToken, type ApiError } from "@/lib/api";
import type { Ticket } from "@/lib/tickets";

// Contacts — the people (and the companies they belong to) who write in. A
// contact is the customer side of a ticket: an identity the api resolves from
// an inbound channel (email / external_id) and enriches with free-form
// `attributes` (plan, region, MRR…). The directory browses/searches them; a
// contact's detail shows their attributes + their ticket history.

export interface Contact {
  id: string;
  external_id: string | null;
  email: string | null;
  name: string;
  company: string;
  /** Free-form enrichment — plan, region, seat count… Always an object (may be empty). */
  attributes: Record<string, string>;
  /** API-relative avatar path (e.g. "/avatar/<uuid>.jpg"), or null when none set. */
  avatar_url: string | null;
  /** Marketing opt-out timestamp — null means subscribed (the default). */
  unsubscribed_at: string | null;
  created_at: string;
  updated_at: string;
  /** Derived: has a name or email (false = anonymous visitor, e.g. a widget conversation). */
  identified?: boolean;
  /** Derived: the contact's first channel identity (widget/email/discord/…). */
  primary_channel?: string | null;
  /** Last widget touch; null = never seen via a live channel. */
  last_seen_at?: string | null;
  /** Derived: last_seen_at within the online window — "active now". */
  online?: boolean;
}

/** One filter-builder condition sent to the API. `field` is a core column key,
 *  "attr:<key>", or "event:<name>" (contact_events timeline — ops limited to
 *  exists / not_exists / after / before); `value` is omitted for existence ops.
 *  (Structurally compatible with the data-table FilterCondition, minus its
 *  client-only `id`.) */
export interface ContactFilter {
  field: string;
  op: string;
  value?: string;
}

export interface ContactListParams {
  q?: string;
  company?: string;
  attrKey?: string;
  attrValue?: string;
  filters?: ContactFilter[];
  /** OR groups: groups OR together, conditions within a group AND together, and
   *  the whole block ANDs with `filters`. Max 10 groups × 25 conditions. */
  filterGroups?: ContactFilter[][];
  /** identified = has a name/email; anonymous = neither (widget visitors etc.). */
  identity?: "identified" | "anonymous";
  sortBy?: string;
  sortDir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface ContactList {
  contacts: Contact[];
  total: number;
}

/** Create/update payload. All optional — the server fills gaps and owns the id. */
export interface ContactInput {
  name?: string;
  email?: string | null;
  company?: string;
  external_id?: string | null;
  attributes?: Record<string, string>;
}

/** Filter-chip phrasing for the unsubscribed_at field — the generic date op labels
 *  ("has any value" / "is unknown") read wrong for an opt-out timestamp, so the
 *  Subscription field speaks plainly. Keyed by filter op; shared by the contacts
 *  directory and broadcast targeting. */
export const SUBSCRIPTION_OP_LABEL: Record<string, string> = {
  exists: "is unsubscribed",
  not_exists: "is subscribed",
  after: "unsubscribed after",
  before: "unsubscribed before",
};

/** One row of a bulk paste. `external_id` or `email` is required server-side to match/insert. */
export interface BulkImportRow {
  external_id?: string;
  email?: string;
  name?: string;
  company?: string;
  attributes?: Record<string, string>;
}

/** True when an error is a 404 — the contacts API isn't deployed on this server yet. */
export function isContactsUnavailable(e: unknown): boolean {
  return (e as ApiError | undefined)?.status === 404;
}

export async function fetchContacts(params: ContactListParams = {}): Promise<ContactList> {
  const qs = new URLSearchParams();
  if (params.q?.trim()) qs.set("q", params.q.trim());
  if (params.company?.trim()) qs.set("company", params.company.trim());
  if (params.attrKey?.trim()) qs.set("attrKey", params.attrKey.trim());
  if (params.attrValue?.trim()) qs.set("attrValue", params.attrValue.trim());
  const packFilter = (f: ContactFilter) => ({
    field: f.field,
    op: f.op,
    ...(f.value !== undefined ? { value: f.value } : {}),
  });
  if (params.filters && params.filters.length) {
    qs.set("filters", JSON.stringify(params.filters.map(packFilter)));
  }
  const groups = (params.filterGroups ?? []).filter((g) => g.length > 0);
  if (groups.length) {
    qs.set("filterGroups", JSON.stringify(groups.map((g) => g.map(packFilter))));
  }
  if (params.identity) qs.set("identity", params.identity);
  if (params.sortBy) qs.set("sortBy", params.sortBy);
  if (params.sortDir) qs.set("sortDir", params.sortDir);
  if (params.limit != null) qs.set("limit", String(params.limit));
  if (params.offset != null) qs.set("offset", String(params.offset));
  const query = qs.toString();
  return api<ContactList>(`/contacts${query ? `?${query}` : ""}`);
}

export async function fetchContact(id: string): Promise<Contact> {
  // The API wraps the row in a { contact } envelope (same as create/update) — unwrap it,
  // else callers get the envelope and every field reads back undefined ("Unnamed contact").
  return (await api<{ contact: Contact }>(`/contacts/${id}`)).contact;
}

/** Every ticket this contact has opened, newest first (server-ordered). */
/** Sentiment mix across a contact's tickets — the trend on the profile. */
export interface SentimentTrend {
  positive: number;
  neutral: number;
  negative: number;
  total: number;
}

export interface ContactHistory {
  tickets: Ticket[];
  sentiment: SentimentTrend;
}

export async function fetchContactHistory(id: string): Promise<ContactHistory> {
  const r = await api<{ tickets: Ticket[]; sentiment?: SentimentTrend }>(`/contacts/${id}/history`);
  return {
    tickets: r.tickets,
    sentiment: r.sentiment ?? { positive: 0, neutral: 0, negative: 0, total: r.tickets.length },
  };
}

// Custom data events (Wave 5): a contact's activity timeline.
export interface ContactEvent {
  id: string;
  contact_id: string;
  name: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export async function fetchContactEvents(id: string): Promise<ContactEvent[]> {
  return (await api<{ events: ContactEvent[] }>(`/contacts/${id}/events`)).events;
}

// Omnichannel unification: the channels a contact is recognized on — one row per
// (channel, external handle) the platform has resolved to this contact.
export interface ContactIdentity {
  id: string;
  channel_type: string;
  external_id: string;
  created_at: string;
}

/** The channels this contact is known on (email/widget/discord/…), server-ordered. */
export async function fetchContactIdentities(id: string): Promise<ContactIdentity[]> {
  return (await api<{ identities: ContactIdentity[] }>(`/contacts/${id}/identities`)).identities;
}

/** Identity resolution — fold `dropId` into `id` (kept), then delete the duplicate. */
export async function mergeContact(id: string, dropId: string): Promise<Contact> {
  return (
    await api<{ contact: Contact }>(`/contacts/${id}/merge`, {
      method: "POST",
      body: JSON.stringify({ dropId }),
    })
  ).contact;
}

export async function createContact(input: ContactInput): Promise<Contact> {
  return (await api<{ contact: Contact }>("/contacts", { method: "POST", body: JSON.stringify(input) }))
    .contact;
}

export async function updateContact(id: string, input: ContactInput): Promise<Contact> {
  return (
    await api<{ contact: Contact }>(`/contacts/${id}`, { method: "PATCH", body: JSON.stringify(input) })
  ).contact;
}

/** Set or clear the marketing opt-out (unsubscribed_at) — the manual path agents
 *  use when a contact asks to be removed from (or re-added to) broadcasts. */
export async function setContactSubscription(id: string, unsubscribed: boolean): Promise<Contact> {
  return (
    await api<{ contact: Contact }>(`/contacts/${id}/subscription`, {
      method: "POST",
      body: JSON.stringify({ unsubscribed }),
    })
  ).contact;
}

export async function deleteContact(id: string): Promise<void> {
  await api(`/contacts/${id}`, { method: "DELETE" });
}

export async function bulkImportContacts(
  rows: BulkImportRow[],
): Promise<{ created: number; updated: number }> {
  return api<{ created: number; updated: number }>("/contacts/bulk", {
    method: "POST",
    body: JSON.stringify({ contacts: rows }),
  });
}

/** CSV import (0092): the api parses the header row and maps email/name/external_id/company +
 *  free-form attribute columns onto the same idempotent upsert. Returns per-outcome counts. */
export async function importContactsCsv(
  csv: string,
): Promise<{ created: number; updated: number; skipped: number; linked?: number }> {
  return api<{ created: number; updated: number; skipped: number; linked?: number }>("/contacts/import", {
    method: "POST",
    body: JSON.stringify({ csv }),
  });
}

/** Download everything we hold about a contact as a JSON bundle (GDPR export, 0092). */
export async function exportContactData(id: string): Promise<Blob> {
  const res = await fetch(`${API_URL}/contacts/${id}/export`, {
    headers: { authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) throw new Error("export failed");
  return res.blob();
}

/** GDPR erasure (0092): hard-delete the contact and every conversation they own. Admin-only. */
export async function eraseContact(id: string): Promise<void> {
  await api(`/contacts/${id}/erase`, { method: "POST" });
}
