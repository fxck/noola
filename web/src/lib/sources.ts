import { api, type ApiError } from "@/lib/api";

// Live sources — external knowledge connectors. Unlike an uploaded document
// (a single file), a source is a *feed* the server keeps fresh: it crawls the
// target (a docs URL / sitemap today), ingests the pages, and makes them
// citable. The client registers/lists/syncs/removes; the crawl runs server-side
// and progress arrives via the realtime bus + polling while a sync is in flight.

export type SourceKind = "url" | "github" | "discord";

export type SourceStatus = "pending" | "syncing" | "ok" | "error";

// Kind-specific connection config. A source only ever populates the fields for
// its own `kind`; the rest stay undefined. Kept as one loose shape (rather than
// a discriminated union) so the row-rendering code can optional-chain any field
// without first narrowing on `kind`. `token` is write-only — the server never
// echoes it back, so a stored github source arrives with `token` undefined.
export interface SourceConfig {
  // url
  url?: string;
  // github
  repo?: string;
  branch?: string;
  path?: string;
  token?: string;
  // discord
  channelId?: string;
  guildId?: string;
  limit?: number;
  /** Forum channels: only solved/answered posts are ingested, distilled into Q&A articles. */
  solvedOnly?: boolean;
  /** Comma-separated forum-tag keywords that count as "solved" (default: solved, answered, resolved, done). */
  solvedTags?: string;
  /** Comma-separated emoji (glyph or name) marking a thread/answer accepted (default: ✅ ☑️ ✔️). */
  solvedReaction?: string;
  /** Distill solved threads into Q&A articles (default true); false keeps the raw transcript. */
  distill?: boolean;
  // Server-set masking flag: true when a write-only credential (github token) is stored.
  // Present on read only; never sent on write.
  has_token?: boolean;
  // Optional per-source sync settings (stored in config jsonb; surfaced in the settings UI).
  sync_interval_minutes?: number;
}

/** One page's fate during a crawl (server-side telemetry, surfaced in the detail's Crawl log). */
export interface CrawlLogEntry {
  url: string;
  outcome: "ingested" | "markdown" | "failed";
  contentType?: string;
  bytes?: number;
}

/** A sync's crawl telemetry — what strategy it took and how each page fared. Present on the
 *  detail read (GET /sources/:id) once a source has synced on the crawl-log schema. */
export interface CrawlLog {
  strategy: string | null;
  startedAt: string;
  finishedAt: string | null;
  ok: boolean;
  error: string | null;
  llmsTxt: { found: boolean; urls: number } | null;
  pagesFetched: number;
  pagesFailed: number;
  totalBytes: number;
  diff: { added: number; updated: number; unchanged: number; removed: number; total: number; failed: number } | null;
  entries: CrawlLogEntry[];
  entriesTruncated: boolean;
}

export interface SourceRow {
  id: string;
  kind: SourceKind;
  label: string;
  config: SourceConfig;
  status: SourceStatus;
  last_error: string | null;
  /** Pages/documents ingested from this source so far. */
  doc_count: number;
  last_synced_at: string | null;
  created_at: string;
  /** Auto-refresh cadence in minutes; null = manual only. A scheduler re-syncs due sources. */
  refresh_interval_minutes: number | null;
  /** Last sync's crawl telemetry (detail read only; null until first sync on the new schema). */
  crawl_log?: CrawlLog | null;
}

export interface CreateSourceInput {
  kind: SourceKind;
  label?: string;
  config: SourceConfig;
  refreshIntervalMinutes?: number | null;
}

/** Auto-refresh cadence presets (minutes). Off = manual only. */
export const REFRESH_PRESETS: { label: string; minutes: number | null }[] = [
  { label: "Manual only", minutes: null },
  { label: "Hourly", minutes: 60 },
  { label: "Daily", minutes: 1440 },
  { label: "Weekly", minutes: 10080 },
];

export function refreshLabel(minutes: number | null): string {
  return REFRESH_PRESETS.find((p) => p.minutes === minutes)?.label
    ?? (minutes ? `Every ${minutes} min` : "Manual only");
}

/** True when an error is a 404 — the live-sources API isn't deployed yet. */
export function isSourcesUnavailable(e: unknown): boolean {
  return (e as ApiError | undefined)?.status === 404;
}

export async function fetchSources(): Promise<SourceRow[]> {
  return (await api<{ sources: SourceRow[] }>("/sources")).sources;
}

/** Fetch a single source by id — backs the routed `/sources/$sourceId` detail page. */
export async function fetchSource(id: string): Promise<SourceRow> {
  return (await api<{ source: SourceRow }>(`/sources/${id}`)).source;
}

export async function createSource(input: CreateSourceInput): Promise<SourceRow> {
  return await api<SourceRow>("/sources", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Update a source's editable settings (label + per-kind config: sync scope/cadence and
 *  credentials). A write-only credential (github token) is PRESERVED when omitted from
 *  config; send a non-empty value to replace it. Never send the `has_token` flag. */
export async function updateSource(
  id: string,
  patch: { label?: string; config?: SourceConfig; refreshIntervalMinutes?: number | null },
): Promise<SourceRow> {
  return (await api<{ source: SourceRow }>(`/sources/${id}`, { method: "PATCH", body: JSON.stringify(patch) })).source;
}

export async function syncSource(id: string): Promise<{ status: string }> {
  return await api<{ status: string }>(`/sources/${id}/sync`, { method: "POST" });
}

export async function deleteSource(id: string): Promise<void> {
  await api(`/sources/${id}`, { method: "DELETE" });
}
