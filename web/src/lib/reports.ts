import { api } from "@/lib/api";

// Report builder-lite (Wave 4 item 14) — the metrics-catalog report engine + saved report
// configs. Saved reports ride the generic segments store (resource="reports"), exactly like
// saved ticket views.

export interface ReportMetricMeta {
  key: string;
  label: string;
  unit: "count" | "hours" | "score" | "percent";
}

export interface ReportConfig {
  metrics: string[];
  from?: string;
  to?: string;
  groupBy?: "day" | "week";
  teamId?: string;
  agentId?: string;
  compare?: boolean;
}

export interface ReportSeries {
  metric: string;
  label: string;
  unit: string;
  points: (number | null)[];
  total: number | null;
}

export interface ReportResult {
  from: string;
  to: string;
  groupBy: "day" | "week";
  buckets: string[];
  series: ReportSeries[];
  compare?: { from: string; to: string; totals: { metric: string; total: number | null }[] };
}

export async function fetchReportMetrics(): Promise<ReportMetricMeta[]> {
  return (await api<{ metrics: ReportMetricMeta[] }>("/analytics/report-metrics")).metrics;
}

export async function runReport(config: ReportConfig): Promise<ReportResult> {
  return (await api<{ report: ReportResult }>("/analytics/report", {
    method: "POST",
    body: JSON.stringify(config),
  })).report;
}

// ── Saved reports (segments, resource="reports") ─────────────────────────────

export interface SavedReport {
  id: string;
  name: string;
  definition: ReportConfig;
}

export async function fetchSavedReports(): Promise<SavedReport[]> {
  const r = await api<{ segments: { id: string; name: string; definition: ReportConfig }[] }>(
    "/segments?resource=reports",
  );
  return r.segments.map((s) => ({ id: s.id, name: s.name, definition: s.definition ?? { metrics: [] } }));
}

export async function saveReport(name: string, definition: ReportConfig): Promise<SavedReport> {
  const r = await api<{ segment: { id: string; name: string; definition: ReportConfig } }>("/segments", {
    method: "POST",
    body: JSON.stringify({ name, resource: "reports", definition }),
  });
  return { id: r.segment.id, name: r.segment.name, definition: r.segment.definition };
}

export async function deleteSavedReport(id: string): Promise<void> {
  await api(`/segments/${id}`, { method: "DELETE" });
}
