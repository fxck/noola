import { api } from "@/lib/api";

// Interactive autonomous agent — runs the same multi-step tool loop Studio uses, on demand
// against a ticket. Defaults to a SAFE dry run (tools report what they'd do); live executes.

export interface AgentRunResult {
  live: boolean;
  steps: string[];
  actions: { type: string; ok: boolean; detail: string }[];
}

export async function runTicketAgent(
  ticketId: string,
  opts: { instructions?: string; tools?: string[]; maxSteps?: number; live?: boolean; model?: string } = {},
): Promise<AgentRunResult> {
  return api<AgentRunResult>(`/tickets/${ticketId}/agent-run`, {
    method: "POST",
    body: JSON.stringify(opts),
  });
}
