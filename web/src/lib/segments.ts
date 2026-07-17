import { api } from "@/lib/api";
import type { ContactFilter } from "@/lib/contacts";

// Saved Segments — named, reusable filters over a resource (contacts today). A segment
// stores the same filter grammar the contacts directory applies, as an opaque `definition`,
// so it can be re-applied later. Tenant is server-authoritative from the session token.

/** The contacts filter grammar a segment persists (mirrors the /contacts query params).
 *  `filterGroups` carries OR-grouped views (groups OR together, conditions within a
 *  group AND together); single-group views keep the flat `filters`. */
export interface SegmentDefinition {
  q?: string;
  filters?: ContactFilter[];
  filterGroups?: ContactFilter[][];
  sortBy?: string;
  sortDir?: "asc" | "desc";
}

export interface Segment {
  id: string;
  name: string;
  resource: string;
  definition: SegmentDefinition;
  created_at: string;
  updated_at: string;
}

export interface SegmentInput {
  name: string;
  resource?: string;
  definition: SegmentDefinition;
}

export async function fetchSegments(resource = "contacts"): Promise<Segment[]> {
  return (await api<{ segments: Segment[] }>(`/segments?resource=${encodeURIComponent(resource)}`)).segments;
}

export async function createSegment(input: SegmentInput): Promise<Segment> {
  return (await api<{ segment: Segment }>("/segments", { method: "POST", body: JSON.stringify(input) })).segment;
}

export async function updateSegment(
  id: string,
  patch: { name?: string; definition?: SegmentDefinition },
): Promise<Segment> {
  return (await api<{ segment: Segment }>(`/segments/${id}`, { method: "PATCH", body: JSON.stringify(patch) })).segment;
}

export async function deleteSegment(id: string): Promise<void> {
  await api(`/segments/${id}`, { method: "DELETE" });
}
