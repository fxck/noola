import { api } from "@/lib/api";

// Conversation QA — each handled ticket is scored on resolution / tone / completeness into an
// overall band. The review list is worst-first so a lead triages the weak conversations. Scoring
// happens automatically on close; the page can re-score one or backfill the recent unscored set.

export type QaBand = "excellent" | "good" | "fair" | "poor";

export interface QaScore {
  ticket_id: string;
  overall: number;
  resolution: number;
  tone: number;
  completeness: number;
  band: QaBand;
  rationale: string;
  model: string;
  scored_at: string;
  subject: string;
  status: string;
  assignee_name: string | null;
}

export interface QaSummary {
  scored: number;
  avgOverall: number | null;
  byBand: Record<QaBand, number>;
}

export const BAND_META: Record<QaBand, { label: string; dot: string; text: string }> = {
  excellent: { label: "Excellent", dot: "var(--success)", text: "text-success" },
  good: { label: "Good", dot: "var(--success)", text: "text-success" },
  fair: { label: "Fair", dot: "var(--warning)", text: "text-warning" },
  poor: { label: "Poor", dot: "var(--destructive)", text: "text-warning" },
};

export const BANDS: QaBand[] = ["excellent", "good", "fair", "poor"];

export async function fetchQa(band?: QaBand): Promise<{ scores: QaScore[]; summary: QaSummary }> {
  const qs = band ? `?band=${band}` : "";
  return api<{ scores: QaScore[]; summary: QaSummary }>(`/qa${qs}`);
}

export async function rescoreTicket(id: string): Promise<QaScore> {
  return (await api<{ score: QaScore }>(`/qa/tickets/${id}/score`, { method: "POST" })).score;
}

export async function backfillQa(limit = 50): Promise<number> {
  return (await api<{ scored: number }>("/qa/backfill", { method: "POST", body: JSON.stringify({ limit }) })).scored;
}

export interface QaAgentRow {
  agentId: string;
  agentName: string;
  scored: number;
  avgOverall: number;
  avgResolution: number;
  avgTone: number;
  avgCompleteness: number;
  byBand: Record<QaBand, number>;
}

export interface QaCsatCorrelation {
  pairs: number;
  avgQaWhenHappy: number | null;
  avgQaWhenUnhappy: number | null;
  avgCsatWhenHighQa: number | null;
  avgCsatWhenLowQa: number | null;
}

export async function fetchQaAgents(): Promise<QaAgentRow[]> {
  return (await api<{ agents: QaAgentRow[] }>("/qa/agents")).agents;
}

export async function fetchQaCorrelation(): Promise<QaCsatCorrelation> {
  return (await api<{ correlation: QaCsatCorrelation }>("/qa/csat-correlation")).correlation;
}
