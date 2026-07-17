import { api } from "./api";

// Content-gap worklist — questions the KB couldn't answer, clustered by occurrence. Surfaced on
// the Sources page so gaps route back into KB authoring (the knowledge-loop).

export interface KnowledgeGap {
  id: string;
  question: string;
  confidence: number | null;
  topScore: number | null;
  agreement: number;
  source: string;
  ticketId: string | null;
  occurrences: number;
  status: "open" | "resolved" | "dismissed";
  resolvedArticleId: string | null;
  firstSeen: string;
  lastSeen: string;
}

export type GapStatusFilter = "open" | "resolved" | "dismissed" | "all";

export async function fetchKnowledgeGaps(status: GapStatusFilter = "open"): Promise<{ gaps: KnowledgeGap[]; openCount: number }> {
  return api(`/knowledge-gaps?status=${status}`);
}

export async function updateKnowledgeGap(
  id: string,
  patch: { status?: "open" | "resolved" | "dismissed"; resolvedArticleId?: string | null },
): Promise<{ gap: KnowledgeGap }> {
  return api(`/knowledge-gaps/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}
