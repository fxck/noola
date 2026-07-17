import { api } from "@/lib/api";

// The AI governance overview (Wave 5 item 22) — one aggregate for the settings hub.

export interface AiOverview {
  model: { provider: string; model: string | null; hasKey: boolean };
  persona: { configured: boolean; tone: string };
  policy: {
    mode: string;
    killSwitch: boolean;
    minConfidence: number | null;
    channelOverrides: number;
    publicSourceKinds: string[];
  };
  queue: { pending: number };
  lastEval: { label: string; avgScore: number | null; autoSendRate: number; createdAt: string } | null;
  activity7d: { drafts: number; autoSent: number; held: number; agentRuns: number; deflected: number };
}

export async function fetchAiOverview(): Promise<AiOverview> {
  return (await api<{ overview: AiOverview }>("/ai/overview")).overview;
}
