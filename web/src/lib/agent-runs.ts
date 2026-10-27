import { api } from "@/lib/api";

// Persisted agent-loop traces (Wave 5 item 17): what the autonomous agent did on a
// ticket and why, step by step. Read-only audit surface for the conversation rail.

export interface AgentStep {
  step: number;
  kind: "action" | "done" | "invalid" | "duplicate" | "error" | "limit";
  tool?: string;
  reason?: string;
  ok?: boolean;
  detail?: string;
}

export interface AgentRun {
  id: string;
  ticket_id: string | null;
  source: "manual" | "automation" | string;
  automation_id: string | null;
  dry_run: boolean;
  status: "done" | "error" | string;
  instructions: string;
  model: string;
  steps: AgentStep[];
  actions: Array<{ type: string; ok: boolean; detail: string }>;
  created_at: string;
}

export async function fetchAgentRuns(ticketId: string): Promise<AgentRun[]> {
  const r = await api<{ runs?: AgentRun[] }>(`/tickets/${ticketId}/agent-runs`);
  return r?.runs ?? [];
}
