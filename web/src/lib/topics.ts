import { api } from "@/lib/api";

// Topics explorer — every ticket carries one primary topic (server-classified on ingest). This
// rolls topics up into volume + a 14-day trend so a team sees what customers contact them about and
// what's rising. Read-only; drill down to the tickets on a topic.

export interface TopicSummary {
  topic: string;
  total: number;
  open: number;
  negative: number;
  last14: number;
  prev14: number;
  trend: number; // percent change, last 14d vs prior 14d
  spark: number[]; // 14 daily counts, oldest → newest
  surge: boolean; // recent volume spiked vs baseline — worth an alert
  surgeRatio: number; // last14 / prev14
}

export interface TopicTicket {
  id: string;
  subject: string;
  status: string;
  priority: string;
  sentiment: string | null;
  created_at: string;
}

export async function fetchTopics(): Promise<TopicSummary[]> {
  return (await api<{ topics: TopicSummary[] }>("/topics")).topics;
}

export async function fetchTopicTickets(topic: string): Promise<TopicTicket[]> {
  return (await api<{ tickets: TopicTicket[] }>(`/topics/${encodeURIComponent(topic)}/tickets`)).tickets;
}

// Human-friendly label + accent per topic (falls back to a title-cased slug + neutral tone).
const LABELS: Record<string, string> = {
  "how-to": "How-to",
  "feature-request": "Feature request",
};
export function topicLabel(topic: string): string {
  return LABELS[topic] ?? topic.charAt(0).toUpperCase() + topic.slice(1).replace(/-/g, " ");
}

export interface ReclassifyResult {
  scanned: number;
  reclassified: number;
  byTopic: Record<string, number>;
}

/** Re-run classification over the 'general' bucket (admin; bounded batch). */
export async function reclassifyTopics(limit = 300): Promise<ReclassifyResult> {
  return api<ReclassifyResult>("/topics/reclassify", {
    method: "POST",
    body: JSON.stringify({ limit }),
  });
}
