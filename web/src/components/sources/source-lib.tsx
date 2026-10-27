// Shared presentation helpers + small components for the Sources surface (the SourcesPage list and
// the SourceDetail page both draw from here). Pure/near-pure: label maps, status pills/dots, title
// derivation, upload-folder grouping, and the segmented-tab class tokens. Extracted from sources.tsx
// to keep the page component focused on state + composition.
import { Globe, Github, MessageCircle, Loader2 } from "lucide-react";
import { type SourceRow, type SourceKind, type SourceStatus } from "@/lib/sources";
import { type SourceDocument } from "@/lib/documents";
import { type Automation, TRIGGERS } from "@/lib/automations";
import { type ComboOption } from "@/components/ui/combobox";
import { cn } from "@/lib/utils";

// all-MiniLM-L6-v2 — each chunk is embedded to a fixed 384-dim vector.
export const EMBED_DIM = 384;

export function relativeTime(iso: string): string {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

// ── live-source presentation helpers ────────────────────────────────────────

export const KIND_ICON: Record<SourceKind, typeof Globe> = {
  url: Globe,
  github: Github,
  discord: MessageCircle,
};

/** The kinds offered in the add-connection form. */
export const KIND_OPTIONS: { value: SourceKind; label: string }[] = [
  { value: "url", label: "Docs URL / sitemap" },
  { value: "github", label: "GitHub repo" },
  { value: "discord", label: "Discord channel" },
];

/** Same kinds as searchable Combobox options (with their type icons). */
export const KIND_COMBO: ComboOption[] = KIND_OPTIONS.map((o) => ({
  value: o.value,
  label: o.label,
  icon: KIND_ICON[o.value],
}));

/** Human label for a source kind (falls back to the raw kind). */
export function kindLabel(kind: SourceKind): string {
  return KIND_OPTIONS.find((o) => o.value === kind)?.label ?? kind;
}

/** A Studio flow counts as a "pipeline" source when its graph writes to the KB (a `kb_upsert`
 *  node) — i.e. it maintains knowledge, the way a connector does. That's the Sources-relevant
 *  signal, and it matches what the "New pipeline" button seeds. */
export function isPipelineFlow(a: Automation): boolean {
  const nodes = a.graph?.nodes ?? [];
  return nodes.some((n) => {
    const action = (n.config as { action?: { type?: string } } | undefined)?.action;
    return action?.type === "kb_upsert";
  });
}

export function pipelineTriggerLabel(t: string): string {
  return TRIGGERS.find((x) => x.value === t)?.label ?? t;
}

export function agoShort(iso: string | null): string {
  if (!iso) return "never run";
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Connected-source groups, in display order. Only groups with items render. */
export const CONNECTED_GROUPS: { kind: SourceKind; label: string }[] = [
  { kind: "github", label: "GitHub" },
  { kind: "url", label: "URLs" },
  { kind: "discord", label: "Discord" },
];

export const STATUS_META: Record<
  SourceStatus,
  { label: string; className: string }
> = {
  pending: { label: "Pending", className: "border-transparent bg-muted text-muted-foreground" },
  syncing: { label: "Syncing", className: "border-primary/25 bg-primary/10 text-primary" },
  ok: { label: "Synced", className: "border-success/25 bg-success/10 text-success" },
  error: { label: "Error", className: "border-destructive/30 bg-destructive/10 text-destructive" },
};


// A small colored status dot for the dense list rows — the compact replacement
// for the fat pill. `role=status` + `aria-label` keep it announced; syncing
// shows a tiny spinner so live crawls read as active.
const STATUS_DOT: Record<SourceStatus, string> = {
  pending: "bg-muted-foreground/40",
  syncing: "bg-primary",
  ok: "bg-success",
  error: "bg-destructive",
};
export function StatusDot({ status, title }: { status: SourceStatus; title?: string }) {
  const label = title ?? STATUS_META[status].label;
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      className="inline-flex size-3.5 shrink-0 items-center justify-center"
    >
      {status === "syncing" ? (
        <Loader2 className="size-3 animate-spin text-primary motion-reduce:animate-none" />
      ) : (
        <span className={cn("size-2 rounded-full", STATUS_DOT[status])} />
      )}
    </span>
  );
}

/** Map an uploaded document's freeform status onto the shared dot palette. */
export function docDot(d: SourceDocument): SourceStatus {
  if (d.last_error) return "error";
  const s = d.status.toLowerCase();
  if (s === "ready" || s === "indexed" || s === "ok") return "ok";
  if (s === "error" || s === "failed") return "error";
  if (s === "pending" || s === "processing" || s === "chunking" || s === "embedding" || s === "syncing")
    return "syncing";
  return "pending";
}

/**
 * A source's display name — its label, else a kind-specific target: the
 * `owner/name` repo for github, `#channelId` for discord, the URL for url.
 */
export function sourceTitle(s: SourceRow): string {
  const label = s.label?.trim();
  if (label) return label;
  const c = s.config ?? {};
  switch (s.kind) {
    case "github":
      return c.repo || s.id;
    case "discord":
      return c.channelId ? `#${c.channelId}` : s.id;
    default:
      return c.url || s.id;
  }
}

/** The secondary line under the title — extra target detail, when it adds any. */
export function sourceSubtitle(s: SourceRow): string | null {
  const c = s.config ?? {};
  switch (s.kind) {
    case "github": {
      const parts = [c.branch, c.path].filter(Boolean) as string[];
      return parts.length ? parts.join(" · ") : null;
    }
    case "discord":
      return c.guildId ? `guild ${c.guildId}` : null;
    default:
      return c.url ?? null;
  }
}

/** Noun for a source's ingested unit — pages for a crawled URL, else docs. */
export function docNoun(s: SourceRow): string {
  if (s.kind === "url") return s.doc_count === 1 ? "page" : "pages";
  return "docs";
}

export function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// owner/name — GitHub's slug shape (letters, digits, dot, dash, underscore).
const GITHUB_REPO_RE = /^[\w.-]+\/[\w.-]+$/;
export function isGithubRepo(v: string): boolean {
  return GITHUB_REPO_RE.test(v.trim());
}

const TYPE_LABEL: Record<string, string> = {
  "text/markdown": "Markdown",
  "text/html": "HTML",
  "text/plain": "Text",
};
export function typeLabel(ct: string): string {
  return TYPE_LABEL[ct] ?? ct.split("/").pop()?.toUpperCase() ?? "File";
}

// ── upload folder grouping ───────────────────────────────────────────────────
// The uploads list is categorized by the leading path of each filename, so a
// crawl dump like `test/fixtures/users/tobi.txt` files under `test/fixtures/users`.
// A bare filename (no `/`) falls into a synthetic "Files" bucket.

export const NO_FOLDER = "Files";
export function folderOf(filename: string): string {
  const i = filename.lastIndexOf("/");
  return i === -1 ? NO_FOLDER : filename.slice(0, i);
}
export function folderBasename(filename: string): string {
  const i = filename.lastIndexOf("/");
  return i === -1 ? filename : filename.slice(i + 1);
}

// ── in-page views ────────────────────────────────────────────────────────────
// The page splits into two dedicated surfaces behind a segmented control:
// live connectors ("Connections") and uploaded files ("Uploads"). Each is its
// own well-spaced view inside a constrained reading column.
export type SourcesView = "connections" | "uploads";

// A file mid-ingest (or just-finished / failed) — drives the per-file upload
// rows atop the uploads list so the user watches each file land.
export interface PendingUpload {
  id: string;
  name: string;
  /** Raw byte size — rendered human-readable in the pending row. */
  size: number;
  /** Upload progress 0–100 (request-body bytes via XHR onprogress). */
  progress: number;
  state: "uploading" | "done" | "error";
  message?: string;
}

// Segmented-control tab styling — canonical home: @/components/ui/segmented.
export { TAB_BASE, TAB_ON, TAB_OFF, TAB_BADGE } from "@/components/ui/segmented";
