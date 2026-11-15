import { api } from "./api";
import type { KbCollection } from "./kb";

// Knowledge gaps: a model reviews each closed conversation and files the reusable questions that the docs or the help articles miss.
// Repeats of one question join a single gap, which lists every conversation that asked it.

export type GapKind = "docs_missing" | "docs_unclear" | "support_knowledge";
export type GapStatus = "open" | "resolved" | "dismissed";

/** A review verdict on one question. Only the gap kinds file a gap, the others count in the summary. */
export type GapReviewKind = GapKind | "answered" | "not_reusable";
export type ConversationKind = "questions" | "account_issue" | "feedback" | "no_question";

/** One conversation that raised the gap, as its review saw it. */
export interface GapQuestion {
  id: string;
  ticketId: string;
  subject: string | null;
  question: string;
  kind: GapKind;
  /** What the team answered. */
  answer: string | null;
  pageUrl: string | null;
  /** The help article that answers it or needs the change. */
  articleId: string | null;
  /** What to add or change. It may hold open questions for the team. */
  suggestion: string | null;
  /** A suggested article title for support_knowledge. */
  title: string | null;
  collection: string | null;
  createdAt: string;
}

export interface KnowledgeGap {
  id: string;
  question: string;
  kind: GapKind;
  /** The docs page to change, or the closest one. */
  pageUrl: string | null;
  /** A suggested KB collection name for support_knowledge. It may not exist yet. */
  collection: string | null;
  /** How many conversations raised it. */
  occurrences: number;
  status: GapStatus;
  resolvedArticleId: string | null;
  firstSeen: string;
  lastSeen: string;
  /** The newest first. */
  questions: GapQuestion[];
}

export interface GapSummary {
  reviewed: number;
  conversations: Record<ConversationKind, number>;
  questions: Record<GapReviewKind, number>;
}

export interface KnowledgeGapList {
  gaps: KnowledgeGap[];
  openCount: number;
  summary: GapSummary;
}

export const isDocsGap = (kind: GapKind) => kind === "docs_missing" || kind === "docs_unclear";

/** The KB collection with the suggested name, ignoring case. */
export function matchCollection(name: string | null, collections: KbCollection[]): KbCollection | null {
  const n = name?.trim().toLowerCase();
  if (!n) return null;
  return collections.find((c) => c.name.trim().toLowerCase() === n) ?? null;
}

export const REVIEW_KIND_LABELS: Record<GapReviewKind, string> = {
  answered: "Answered by your sources",
  docs_missing: "Missing from the docs",
  docs_unclear: "Unclear in the docs",
  support_knowledge: "Belongs in a help article",
  not_reusable: "Not reusable",
};

export async function fetchKnowledgeGaps(status: GapStatus | "all" = "open"): Promise<KnowledgeGapList> {
  return api(`/knowledge-gaps?status=${status}`);
}

export async function updateKnowledgeGap(
  id: string,
  patch: { status?: GapStatus; resolvedArticleId?: string | null },
): Promise<{ gap: KnowledgeGap }> {
  return api(`/knowledge-gaps/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}
