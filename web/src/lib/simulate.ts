import { api } from "@/lib/api";

// Agent simulation — run the AI resolver over a sample of past tickets (no send), and see how it
// WOULD have answered: a would-be QA score, retrieval grounding, and whether it would clear the
// auto-send gate. A readiness report you run before trusting the agent.

export interface SimItem {
  ticket_id: string;
  subject: string;
  question: string;
  draft: string;
  score: number;
  confidence: number | null;
  agreement: number;
  citations: number;
  would_auto_send: boolean;
}

export interface SimRun {
  id: string;
  label: string;
  sample_size: number;
  avg_score: number | null;
  avg_confidence: number | null;
  auto_send_rate: number; // 0..1
  coverage: number; // 0..1
  model: string;
  created_at: string;
}

export async function fetchSimulations(): Promise<SimRun[]> {
  return (await api<{ runs: SimRun[] }>("/simulations")).runs;
}

export async function fetchSimulation(id: string): Promise<{ run: SimRun; items: SimItem[] }> {
  return api<{ run: SimRun; items: SimItem[] }>(`/simulations/${id}`);
}

export async function runSimulation(sampleSize: number, label?: string): Promise<{ run: SimRun; items: SimItem[] }> {
  return api<{ run: SimRun; items: SimItem[] }>("/simulations", {
    method: "POST",
    body: JSON.stringify({ sampleSize, label }),
  });
}
