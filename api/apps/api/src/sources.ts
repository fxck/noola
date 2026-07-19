import { withTenant, relayPool } from "@repo/db";
import { EVENT_TYPES } from "@repo/contracts";
import { deleteDocumentsBySource, syncDocuments, type SyncDiff } from "./documents.js";
import { resolveModelDriver } from "./modelconfig.js";
import { canonicalEmojiName } from "./classification.js";

// Live-sources connector vertical. A tenant registers an external source (a docs URL /
// sitemap now; GitHub / Discord later); a sync engine runs the source's connector,
// converts the fetched units to text, and ingests them through the existing document
// pipeline tagged by source_id — so they become citable in retrieval. Re-sync replaces
// the source's docs (delete-by-source → re-ingest). The per-kind CONNECTORS registry is
// the clean seam: adding a connector is one map entry, no changes to sync/CRUD/routes.

export type Kind = "url" | "github" | "discord";

export interface SourceRow {
  id: string;
  kind: Kind;
  label: string;
  config: Record<string, unknown>;
  status: string; // pending | syncing | ok | error
  last_error: string | null;
  doc_count: number;
  last_synced_at: string | null;
  created_at: string;
  // Auto-refresh cadence in minutes; null = manual only. A per-minute scheduler re-syncs sources
  // whose interval has elapsed (scheduled source re-crawl).
  refresh_interval_minutes: number | null;
  // Opaque upstream-revision token (github head SHA today); lets a resync short-circuit when nothing
  // moved. null = no token recorded (always full sync). Reset on config change. See syncSource.
  last_sync_token: string | null;
  // Last sync's crawl telemetry (detail read only — never selected in the list query). null until
  // the first sync on this schema.
  crawl_log?: CrawlLog | null;
}

const SOURCE_COLS =
  "id, kind, label, config, status, last_error, doc_count, last_synced_at, created_at, refresh_interval_minutes, last_sync_token";

// ---- CRUD -----------------------------------------------------------------

export async function listSources(tenantId: string): Promise<SourceRow[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(`SELECT ${SOURCE_COLS} FROM sources ORDER BY created_at DESC LIMIT 200`);
    return r.rows as SourceRow[];
  });
}

export async function getSource(tenantId: string, id: string): Promise<SourceRow | null> {
  return withTenant(tenantId, async (c) => {
    // Detail read pulls the crawl_log jsonb too (the list query omits it — it's heavy and per-detail).
    const r = await c.query(`SELECT ${SOURCE_COLS}, crawl_log FROM sources WHERE id = $1`, [id]);
    return r.rowCount ? (r.rows[0] as SourceRow) : null;
  });
}

export async function createSource(
  tenantId: string,
  input: { kind: Kind; label?: string; config: Record<string, unknown>; refreshIntervalMinutes?: number | null },
): Promise<SourceRow> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO sources (tenant_id, kind, label, config, refresh_interval_minutes)
       VALUES (current_tenant(), $1, $2, $3::jsonb, $4) RETURNING ${SOURCE_COLS}`,
      [input.kind, input.label ?? "", JSON.stringify(input.config ?? {}), input.refreshIntervalMinutes ?? null],
    );
    return r.rows[0] as SourceRow;
  });
}

// Config keys that hold a secret credential: stored so the connector can authenticate,
// but write-only over the wire — never echoed back. GET responses mask them (see
// maskSource); syncSource reads the UNmasked row via getSource.
const SENSITIVE_CONFIG_KEYS = ["token"] as const;

/** Strip write-only credentials from a source's config before it leaves the API, replacing
 *  each with a boolean `has_<key>` flag so the UI can show "a credential is set" without
 *  exposing it. Apply at the HTTP boundary ONLY — internal callers (syncSource) need the
 *  real value. */
export function maskSource(row: SourceRow): SourceRow {
  const config: Record<string, unknown> = { ...row.config };
  for (const k of SENSITIVE_CONFIG_KEYS) {
    const v = config[k];
    if (v !== undefined && v !== null && v !== "") config[`has_${k}`] = true;
    delete config[k];
  }
  return { ...row, config };
}

/**
 * Update a source's editable settings — its label and per-kind config (sync scope,
 * cadence, credentials). `kind` is immutable. Write-only credentials (token) are PRESERVED
 * when the incoming config omits or blanks them (the client never sees the stored value to
 * echo back); a non-empty incoming value replaces the stored one. Non-sensitive keys are
 * replaced wholesale by the incoming config. Returns null if the source isn't in the tenant.
 */
export async function updateSource(
  tenantId: string,
  id: string,
  patch: { label?: string; config?: Record<string, unknown>; refreshIntervalMinutes?: number | null },
): Promise<SourceRow | null> {
  const existing = await getSource(tenantId, id);
  if (!existing) return null;

  let nextConfig: Record<string, unknown> = existing.config;
  if (patch.config !== undefined) {
    nextConfig = { ...patch.config };
    // Never let a masking flag round-trip into stored config.
    for (const k of SENSITIVE_CONFIG_KEYS) delete nextConfig[`has_${k}`];
    // Preserve write-only credentials the client didn't (re)supply.
    for (const k of SENSITIVE_CONFIG_KEYS) {
      const incoming = nextConfig[k];
      if (incoming === undefined || incoming === null || incoming === "") {
        if (existing.config[k] !== undefined) nextConfig[k] = existing.config[k];
        else delete nextConfig[k];
      }
    }
  }

  // refreshIntervalMinutes is set only when the patch carries it (null is a valid value —
  // "turn auto-refresh off" — so COALESCE won't do; include the column conditionally).
  const setRefresh = patch.refreshIntervalMinutes !== undefined;
  // A config change invalidates the resync short-circuit token: a new repo/branch/path (or any
  // connector setting) means the stored token no longer describes what a fetch would return, so the
  // next sync must run in full. Clearing it is the safe default.
  const resetToken = patch.config !== undefined;
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `UPDATE sources SET label = COALESCE($2, label), config = $3::jsonb${setRefresh ? ", refresh_interval_minutes = $4" : ""}${resetToken ? ", last_sync_token = NULL" : ""}
        WHERE id = $1 RETURNING ${SOURCE_COLS}`,
      setRefresh
        ? [id, patch.label ?? null, JSON.stringify(nextConfig), patch.refreshIntervalMinutes]
        : [id, patch.label ?? null, JSON.stringify(nextConfig)],
    );
    return r.rowCount ? (r.rows[0] as SourceRow) : null;
  });
}

/** Delete a source AND all its ingested docs (delete-by-source clears the indexes too). */
export async function deleteSource(tenantId: string, id: string): Promise<boolean> {
  await deleteDocumentsBySource(tenantId, id);
  return withTenant(tenantId, async (c) => {
    const r = await c.query("DELETE FROM sources WHERE id = $1", [id]);
    return (r.rowCount ?? 0) > 0;
  });
}

// ---- Connector registry ---------------------------------------------------

/** One fetched unit from a source — becomes one ingested document (tagged by source_id).
 *  keep:true = "unchanged upstream, keep the stored doc" (content ignored — lets connectors skip
 *  expensive regeneration like model distillation on re-crawls). */
export type ConnectorUnit = { key: string; title: string; contentType: string; content: string; keep?: boolean };
/** Sync context handed to connectors: tenant (model seam for distillation) + stored doc keys +
 *  an optional crawl-telemetry sink the connector fills as it fetches (surfaced in the source
 *  detail's "Crawl log" panel). */
export interface ConnectorCtx { tenantId: string; existingKeys: Set<string>; crawl?: CrawlLog }
export type Connector = (config: Record<string, unknown>, ctx?: ConnectorCtx) => Promise<ConnectorUnit[]>;

// ---- crawl telemetry ------------------------------------------------------
// A serializable record of what one sync actually did — stored on sources.crawl_log (jsonb) and
// rendered in the UI so an operator can see WHY a crawl fetched N pages (strategy taken, llms.txt
// hit/miss, per-page outcome), rather than guessing from a bare page count.

/** One page's fate during a crawl. `markdown` = the clean `.md` twin was indexed; `ingested` =
 *  the HTML/text page itself; `failed` = fetch/parse returned nothing (skipped). */
export interface CrawlLogEntry {
  url: string;
  outcome: "ingested" | "markdown" | "failed";
  contentType?: string;
  bytes?: number;
}

export interface CrawlLog {
  /** How the crawl enumerated pages: sitemap | sitemapindex | llms.txt | links | single | null. */
  strategy: string | null;
  startedAt: string;
  finishedAt: string | null;
  ok: boolean;
  error: string | null;
  /** URL-connector /llms.txt probe: whether one was found and how many doc URLs it listed. */
  llmsTxt: { found: boolean; urls: number } | null;
  pagesFetched: number;
  pagesFailed: number;
  totalBytes: number;
  /** The incremental diff the sync produced (added/updated/unchanged/removed/failed) — set post-ingest. */
  diff: { added: number; updated: number; unchanged: number; removed: number; total: number; failed: number } | null;
  entries: CrawlLogEntry[];
  entriesTruncated: boolean;
}

// A pathological sitemap could list tens of thousands of URLs; cap the per-page detail we persist
// (the summary counts stay exact) so the jsonb blob can't grow unbounded.
const CRAWL_LOG_MAX_ENTRIES = 600;

export function newCrawlLog(): CrawlLog {
  return {
    strategy: null, startedAt: new Date().toISOString(), finishedAt: null, ok: false, error: null,
    llmsTxt: null, pagesFetched: 0, pagesFailed: 0, totalBytes: 0, diff: null, entries: [], entriesTruncated: false,
  };
}

/** Record one page outcome into the crawl log (no-op when no sink — e.g. a direct connector call in
 *  tests). Summary counters stay exact even past the per-entry cap. */
function logCrawlPage(crawl: CrawlLog | undefined, e: CrawlLogEntry): void {
  if (!crawl) return;
  if (e.outcome === "failed") crawl.pagesFailed += 1;
  else crawl.pagesFetched += 1;
  if (e.bytes) crawl.totalBytes += e.bytes;
  if (crawl.entries.length < CRAWL_LOG_MAX_ENTRIES) crawl.entries.push(e);
  else crawl.entriesTruncated = true;
}

function connectorError(msg: string, statusCode: number): Error & { statusCode?: number } {
  return Object.assign(new Error(msg), { statusCode });
}

/** Fetch with an abort timeout — shared by every connector's HTTP calls. */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Per-kind connector seam. Add a kind = add one entry here (+ the enum). All three are
 *  live; `config` shapes: url={url}, github={repo,branch?,path?,token?}, discord={channelId,
 *  guildId?,limit?}. Failures surface via syncSource (status='error' + last_error). */
const CONNECTORS: Record<Kind, Connector> = {
  url: fetchUrlUnits,
  github: fetchGithubUnits,
  discord: fetchDiscordUnits,
};

/** A cheap "did anything change upstream?" probe run BEFORE the full connector. Returns an opaque
 *  revision token (github head commit SHA today); syncSource compares it to the source's stored
 *  token and skips the whole crawl when they match. token=null → couldn't tell, so do a full sync
 *  (this seam never produces a false "unchanged"). Only kinds with a cheap revision check appear. */
export type Precheck = (config: Record<string, unknown>) => Promise<{ token: string | null }>;

const PRECHECKS: Partial<Record<Kind, Precheck>> = {
  github: githubHeadSha,
};

// ---- URL / web connector --------------------------------------------------

const PAGE_TIMEOUT_MS = 10_000;
const MAX_PAGE_BYTES = 2_000_000; // ~2MB per page
// Generous page cap so a real docs site (e.g. docs.zerops.io ≈ 340 pages via llms.txt) is
// crawled whole; MAX_TOTAL_BYTES is the true safety ceiling that bounds a pathological/huge
// site regardless of page count.
const MAX_PAGES = 500;
const MAX_TOTAL_BYTES = 48_000_000; // hard ceiling across a whole crawl

/**
 * SSRF guard — best-effort. Only http/https, and block obviously-internal hosts
 * (loopback, link-local, RFC1918, .internal/.local). This is a hostname/literal-IP
 * check only; it does NOT resolve DNS, so a hostname that resolves to a private IP
 * still slips through.
 * TODO harden SSRF before prod: resolve the host, re-check every redirect hop against
 * the resolved IP, and pin the connection to the vetted address.
 */
function isAllowedUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "[::1]"
  ) {
    return null;
  }
  // literal IPv4 in a blocked range
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (
      a === 127 || // loopback
      a === 10 || // 10.0.0.0/8
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
      (a === 192 && b === 168) || // 192.168.0.0/16
      (a === 169 && b === 254) || // 169.254.0.0/16 link-local (incl. cloud metadata)
      a === 0
    ) {
      return null;
    }
  }
  return u;
}

/** Map a raw Content-Type header to a supported canonical text type, or null (skip). */
function classifyContentType(ct: string): "text/html" | "text/markdown" | "text/plain" | null {
  const c = ct.toLowerCase();
  if (c.includes("html") || c.includes("xml")) return "text/html"; // xml sitemaps too (parsed separately)
  if (c.includes("markdown")) return "text/markdown";
  if (c.startsWith("text/")) return "text/plain";
  return null;
}

interface Fetched {
  url: string;
  contentType: "text/html" | "text/markdown" | "text/plain";
  body: string;
  rawType: string;
}

/** Fetch one URL with a timeout + per-page byte cap. Returns null on any failure or on a
 *  non-text/binary response (so a crawl silently skips those, never ingesting binaries). */
async function fetchPage(u: URL): Promise<Fetched | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PAGE_TIMEOUT_MS);
  try {
    const res = await fetch(u.toString(), {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "user-agent": "noola-source-sync/1.0", accept: "text/html,text/plain,text/markdown,application/xml;q=0.9,*/*;q=0.1" },
    });
    if (!res.ok) return null;
    const rawType = res.headers.get("content-type") ?? "text/plain";
    const canonical = classifyContentType(rawType);
    if (!canonical) return null; // skip binaries / unknown
    // Bound the read: slice to the byte cap rather than trusting Content-Length.
    const buf = await res.arrayBuffer();
    const bytes = buf.byteLength > MAX_PAGE_BYTES ? buf.slice(0, MAX_PAGE_BYTES) : buf;
    const body = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return { url: u.toString(), contentType: canonical, body, rawType };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function titleOf(html: string, fallback: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const t = m ? m[1].replace(/\s+/g, " ").trim() : "";
  return t || fallback;
}

function isSitemap(body: string, rawType: string): boolean {
  if (rawType.toLowerCase().includes("xml")) {
    return /<urlset[\s>]|<sitemapindex[\s>]/i.test(body);
  }
  return /<urlset[\s>]|<sitemapindex[\s>]/i.test(body.slice(0, 4000));
}

function extractLocs(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(decodeEntities(m[1].trim()));
  return out;
}

/** Same-origin <a href> links, resolved to absolute, deduped. */
function extractLinks(html: string, base: URL): string[] {
  const out = new Set<string>();
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const abs = new URL(decodeEntities(m[1].trim()), base);
      abs.hash = "";
      if (abs.origin === base.origin && (abs.protocol === "http:" || abs.protocol === "https:")) {
        out.add(abs.toString());
      }
    } catch {
      /* skip malformed href */
    }
  }
  return [...out];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

/** Resolve one link target to absolute against the page URL, or null to leave it untouched
 *  (already absolute, an in-page anchor, or a non-navigational scheme like mailto:/data:). */
function toAbsoluteLink(ref: string, base: string): string | null {
  const r = ref.trim();
  if (!r || r.startsWith("#")) return null;
  if (r.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(r)) return null; // protocol-relative or scheme-qualified
  try {
    const abs = new URL(r, base).toString();
    return abs === r ? null : abs;
  } catch {
    return null;
  }
}

/** Rewrite relative links in crawled content to absolute URLs, based on the page's own URL. A doc's
 *  `.md` twin (and its HTML) stores links like `/references/networking/l7` — quoted verbatim into an
 *  AI answer those resolve against the wrong host and 404. Rewriting them at ingest keeps every cited
 *  link live. Markdown inline/image links + reference definitions; HTML href/src. Plain text is left
 *  alone (no link syntax to resolve). */
export function absolutizeLinks(content: string, contentType: string, pageUrl: string): string {
  if (contentType === "text/markdown") {
    return content
      // inline [text](target) and ![alt](target …"title")
      .replace(/(!?\[[^\]]*\]\()\s*([^)\s]+)(\s*(?:"[^"]*"|'[^']*')?\s*\))/g, (whole, pre, target, post) => {
        const abs = toAbsoluteLink(target, pageUrl);
        return abs ? `${pre}${abs}${post}` : whole;
      })
      // reference-style definitions: [id]: target
      .replace(/^(\s*\[[^\]]+\]:\s*)(\S+)/gm, (whole, pre, target) => {
        const abs = toAbsoluteLink(target, pageUrl);
        return abs ? `${pre}${abs}` : whole;
      });
  }
  if (contentType === "text/html") {
    return content.replace(/\b(href|src)\s*=\s*("([^"]*)"|'([^']*)')/gi, (whole, attr, _q, dq, sq) => {
      const abs = toAbsoluteLink(dq ?? sq ?? "", pageUrl);
      return abs ? `${attr}="${abs}"` : whole;
    });
  }
  return content; // text/plain — nothing to resolve
}

// ---- llms.txt + Markdown content-negotiation (modern docs conventions) -----
// Docs sites increasingly publish two LLM-friendly affordances we prefer over blind HTML scraping:
//   • /llms.txt — a curated Markdown index of the canonical doc URLs (https://llmstxt.org). When a
//     site has one, it's a far cleaner crawl manifest than following every same-origin <a href>.
//   • a `.md` (or `.md.txt`) twin of each doc page — the raw Markdown the page was rendered from.
//     Indexing that instead of stripped HTML gives the retriever clean structure, not nav chrome.

const LLMS_TXT_PATH = "/llms.txt";

/** Parse an llms.txt body into same-origin doc URLs: Markdown links `[label](url)` first, then any
 *  bare http(s) URLs. Cross-origin and non-http links are dropped; result is deduped, order-preserved.
 *  (Section headers / prose are ignored — only the links matter as the crawl manifest.) */
export function parseLlmsTxt(body: string, base: URL): string[] {
  const out = new Set<string>();
  const add = (raw: string): void => {
    try {
      const abs = new URL(raw.trim(), base);
      abs.hash = "";
      // Skip the llms.txt aggregates (llms.txt / llms-full.txt / llms-small.txt): they are the
      // whole doc set concatenated into one file. Ingesting them alongside the per-page .md links
      // this same manifest lists would duplicate every passage in retrieval. The per-page docs win.
      if (/\/llms(-[\w-]+)?\.txt$/i.test(abs.pathname)) return;
      if (abs.origin === base.origin && (abs.protocol === "http:" || abs.protocol === "https:")) out.add(abs.toString());
    } catch {
      /* skip malformed */
    }
  };
  // Markdown links: [text](url)
  const md = /\[[^\]]*\]\(\s*([^)\s]+)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = md.exec(body)) !== null) add(m[1]);
  // Bare URLs on their own (outside a markdown link) — catch plain-list llms.txt files too.
  const bare = /(?<![("[])\bhttps?:\/\/[^\s)"'<>]+/gi;
  while ((m = bare.exec(body)) !== null) add(m[0]);
  return [...out];
}

/** The `.md` twin of a doc page URL, or null when there's no sensible candidate (already .md/.txt,
 *  a file with a non-page extension, or a bare origin). `/docs/x` → `/docs/x.md`; `/docs/x/` →
 *  `/docs/x.md`; `/docs/x.html` → `/docs/x.md`. */
export function markdownVariantUrl(u: URL): URL | null {
  let path = u.pathname;
  if (path === "" || path === "/") return null; // origin root — no page to negotiate
  if (path.endsWith("/")) path = path.slice(0, -1);
  const last = path.slice(path.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  const ext = dot > 0 ? last.slice(dot + 1).toLowerCase() : "";
  if (ext === "md" || ext === "markdown" || ext === "txt") return null; // already text — nothing to gain
  let mdPath: string;
  if (ext === "html" || ext === "htm") mdPath = path.slice(0, path.length - (ext.length + 1)) + ".md";
  else if (ext) return null; // some other file extension (.pdf/.png/…) — not a doc page
  else mdPath = path + ".md";
  const cand = new URL(u.toString());
  cand.pathname = mdPath;
  return cand;
}

/** A `.md` endpoint that soft-404s often returns the SPA shell (HTML) with a 200 — reject that so we
 *  fall back to the real page instead of indexing an app skeleton. */
export function looksLikeHtml(body: string): boolean {
  const head = body.slice(0, 400).toLowerCase();
  return head.includes("<!doctype html") || head.includes("<html") || /<head[\s>]/.test(head);
}

/** Try the Markdown twin of a page; return it (keyed to the ORIGINAL page url so diffing/citation stay
 *  stable) only when it's real Markdown/plain text, not an HTML soft-404. null → caller uses the page. */
async function fetchMarkdownVariant(u: URL): Promise<Fetched | null> {
  const cand = markdownVariantUrl(u);
  if (!cand) return null;
  const md = await fetchPage(cand);
  if (!md) return null;
  if (md.contentType === "text/html" || looksLikeHtml(md.body)) return null;
  // Keep the canonical page URL as the identity; swap in the markdown body.
  return { url: u.toString(), contentType: "text/markdown", body: md.body, rawType: md.rawType };
}

/** Fetch a doc page, preferring its clean `.md` twin when the site serves one; otherwise the page
 *  itself. The returned unit is always keyed to the canonical page URL. */
async function fetchPagePreferMarkdown(u: URL): Promise<Fetched | null> {
  const md = await fetchMarkdownVariant(u);
  if (md) return md;
  return fetchPage(u);
}

/** Probe a site's /llms.txt and return its curated same-origin doc URLs, or [] when absent. */
async function discoverLlmsTxt(origin: URL): Promise<string[]> {
  try {
    const u = new URL(LLMS_TXT_PATH, origin.origin);
    const res = await fetchPage(u);
    if (!res) return [];
    return parseLlmsTxt(res.body, origin);
  } catch {
    return [];
  }
}

/**
 * URL/web connector. `config.url` is the entry point:
 *  - an XML sitemap (<urlset>) → crawl its <loc> pages (same-origin, capped, deduped);
 *  - a sitemapindex → fetch child sitemaps one level, then their <loc> pages;
 *  - otherwise a single HTML/text page, and follow its same-origin <a href> links one
 *    level deep (up to MAX_PAGES total).
 * Only html/markdown/plain responses are kept (binaries skipped). Total bytes bounded.
 */
export async function fetchUrlUnits(config: Record<string, unknown>, ctx?: ConnectorCtx): Promise<ConnectorUnit[]> {
  const crawl = ctx?.crawl;
  const entry = typeof config.url === "string" ? config.url : "";
  const start = isAllowedUrl(entry);
  if (!start) {
    throw Object.assign(new Error(`url connector: blocked or invalid url: ${entry}`), { statusCode: 400 });
  }

  const units: ConnectorUnit[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  const ingestPage = (p: Fetched): void => {
    totalBytes += p.body.length;
    logCrawlPage(crawl, {
      url: p.url,
      outcome: p.contentType === "text/markdown" ? "markdown" : "ingested",
      contentType: p.contentType,
      bytes: p.body.length,
    });
    units.push({
      key: p.url,
      title: p.contentType === "text/html" ? titleOf(p.body, p.url) : p.url,
      contentType: p.contentType,
      content: absolutizeLinks(p.body, p.contentType, p.url),
    });
  };

  const root = await fetchPage(start);
  if (!root) throw Object.assign(new Error(`url connector: fetch failed for ${entry}`), { statusCode: 502 });
  seen.add(start.toString());

  // ---- sitemap path ----
  if (isSitemap(root.body, root.rawType)) {
    const isIndex = /<sitemapindex[\s>]/i.test(root.body);
    if (crawl) crawl.strategy = isIndex ? "sitemapindex" : "sitemap";
    let pageUrls: string[] = [];
    if (isIndex) {
      // one level of child sitemaps → collect their <loc> page urls
      const childSitemaps = extractLocs(root.body).slice(0, MAX_PAGES);
      for (const cs of childSitemaps) {
        const cu = isAllowedUrl(cs);
        if (!cu || cu.origin !== start.origin) continue;
        const child = await fetchPage(cu);
        if (child) pageUrls.push(...extractLocs(child.body));
        if (pageUrls.length >= MAX_PAGES) break;
      }
    } else {
      pageUrls = extractLocs(root.body);
    }
    for (const link of pageUrls) {
      if (units.length >= MAX_PAGES || totalBytes >= MAX_TOTAL_BYTES) break;
      const lu = isAllowedUrl(link);
      if (!lu || lu.origin !== start.origin) continue;
      const key = lu.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      const p = await fetchPagePreferMarkdown(lu);
      if (p) ingestPage(p);
      else logCrawlPage(crawl, { url: key, outcome: "failed" });
    }
    if (crawl) crawl.totalBytes = totalBytes;
    return units;
  }

  // ---- single page (+ one level of same-origin links) ----
  ingestPage(root);
  if (root.contentType === "text/html") {
    // Prefer a curated /llms.txt manifest (clean list of the canonical doc URLs) over blind
    // same-origin link-following; fall back to <a href> discovery when the site has none.
    const llms = await discoverLlmsTxt(start);
    if (crawl) {
      crawl.llmsTxt = { found: llms.length > 0, urls: llms.length };
      crawl.strategy = llms.length ? "llms.txt" : "links";
    }
    const links = llms.length ? llms : extractLinks(root.body, start);
    for (const link of links) {
      if (units.length >= MAX_PAGES || totalBytes >= MAX_TOTAL_BYTES) break;
      const lu = isAllowedUrl(link);
      if (!lu || lu.origin !== start.origin) continue;
      const key = lu.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      const p = await fetchPagePreferMarkdown(lu);
      if (p) ingestPage(p);
      else logCrawlPage(crawl, { url: key, outcome: "failed" });
    }
  } else if (crawl) {
    // A single non-HTML entry (a lone markdown/plain doc) — no link discovery.
    crawl.strategy = "single";
  }
  if (crawl) crawl.totalBytes = totalBytes;
  return units;
}

// ---- GitHub connector -----------------------------------------------------

const GITHUB_API = "https://api.github.com";
const GITHUB_RAW = "https://raw.githubusercontent.com";
const GH_TIMEOUT_MS = 10_000;
const GH_MAX_FILES = 150;
const GH_MAX_TOTAL_BYTES = 24_000_000; // ~24MB across the whole repo sync
const GH_MAX_FILE_BYTES = 1_000_000; // ~1MB per blob
const GH_DOC_EXT = /\.(md|mdx|markdown|txt|rst)$/i;

/** One entry of the GitHub git-tree response (only the fields we use). */
export type GithubTreeEntry = { path: string; type: string; size?: number };

function githubHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    "user-agent": "noola-connector", // GitHub rejects requests without a UA
    accept: "application/vnd.github+json",
  };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

/** text/plain for .txt/.rst, text/markdown for the markdown family. */
function githubContentType(filepath: string): "text/markdown" | "text/plain" {
  return /\.(txt|rst)$/i.test(filepath) ? "text/plain" : "text/markdown";
}

/**
 * Pure tree filter (unit-tested without the network): keep blob entries whose extension
 * is docs-like (.md/.mdx/.markdown/.txt/.rst) and — when `subPath` is set — that live
 * under it. Caps at GH_MAX_FILES and stops once the cumulative blob size would exceed
 * GH_MAX_TOTAL_BYTES. Deterministic; preserves tree order.
 */
export function filterGithubTree(entries: GithubTreeEntry[], subPath?: string): string[] {
  const prefix = (subPath ?? "").replace(/^\/+|\/+$/g, "");
  const under = prefix ? `${prefix}/` : "";
  const out: string[] = [];
  let total = 0;
  for (const e of entries) {
    if (e.type !== "blob" || !e.path) continue;
    if (!GH_DOC_EXT.test(e.path)) continue;
    if (under && !e.path.startsWith(under)) continue;
    const size = typeof e.size === "number" ? e.size : 0;
    if (total + size > GH_MAX_TOTAL_BYTES) break;
    total += size;
    out.push(e.path);
    if (out.length >= GH_MAX_FILES) break;
  }
  return out;
}

/** A 403 with x-ratelimit-remaining: 0 means we're rate-limited (vs. a real permission 403). */
function githubRateLimited(res: Response): boolean {
  return res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0";
}

const encodePath = (p: string): string => p.split("/").map(encodeURIComponent).join("/");

/** Fetch one blob's raw text. Public repos → raw.githubusercontent; with a token → the
 *  contents API (works for private repos). Returns null on any per-file failure so one bad
 *  file never aborts the whole sync. Capped at GH_MAX_FILE_BYTES. */
async function fetchGithubBlob(
  owner: string,
  name: string,
  branch: string,
  filepath: string,
  token: string | undefined,
): Promise<string | null> {
  let url: string;
  let headers: Record<string, string>;
  if (token) {
    url = `${GITHUB_API}/repos/${owner}/${name}/contents/${encodePath(filepath)}?ref=${encodeURIComponent(branch)}`;
    headers = { ...githubHeaders(token), accept: "application/vnd.github.raw+json" };
  } else {
    url = `${GITHUB_RAW}/${owner}/${name}/${branch}/${encodePath(filepath)}`;
    headers = { "user-agent": "noola-connector" };
  }
  try {
    const res = await fetchWithTimeout(url, { headers, redirect: "follow" }, GH_TIMEOUT_MS);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const bytes = buf.byteLength > GH_MAX_FILE_BYTES ? buf.slice(0, GH_MAX_FILE_BYTES) : buf;
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * GitHub connector. `config`: { repo: "owner/name", branch?, path?, token? }.
 * Resolves the default branch when omitted, lists the repo via the recursive git-tree,
 * keeps docs-like blobs (optionally under `path`), and fetches each as a text/markdown
 * (or text/plain) unit keyed by its filepath. Public repos work unauthenticated
 * (60 req/hr); a token lifts the limit and unlocks private repos.
 */
export async function fetchGithubUnits(config: Record<string, unknown>): Promise<ConnectorUnit[]> {
  const repo = typeof config.repo === "string" ? config.repo.trim() : "";
  const m = repo.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!m) throw connectorError(`github connector: repo must be 'owner/name': ${repo || "(empty)"}`, 400);
  const [, owner, name] = m;
  const token = typeof config.token === "string" && config.token.trim() ? config.token.trim() : undefined;
  const subPath = typeof config.path === "string" ? config.path : undefined;
  const headers = githubHeaders(token);

  // resolve the branch (default branch when omitted)
  let branch = typeof config.branch === "string" && config.branch.trim() ? config.branch.trim() : "";
  if (!branch) {
    const rres = await fetchWithTimeout(`${GITHUB_API}/repos/${owner}/${name}`, { headers }, GH_TIMEOUT_MS);
    if (rres.status === 404) throw connectorError("github connector: repo not found or private (needs a token)", 404);
    if (githubRateLimited(rres)) throw connectorError("github connector: github rate limit — add a token", 429);
    if (!rres.ok) throw connectorError(`github connector: repo lookup failed (${rres.status})`, 502);
    const meta = (await rres.json()) as { default_branch?: string };
    branch = meta.default_branch || "main";
  }

  // list files via the recursive git-tree
  const tres = await fetchWithTimeout(
    `${GITHUB_API}/repos/${owner}/${name}/git/trees/${branch}?recursive=1`,
    { headers },
    GH_TIMEOUT_MS,
  );
  if (tres.status === 404) throw connectorError("github connector: repo not found or private (needs a token)", 404);
  if (githubRateLimited(tres)) throw connectorError("github connector: github rate limit — add a token", 429);
  if (!tres.ok) throw connectorError(`github connector: tree fetch failed (${tres.status})`, 502);
  const tree = (await tres.json()) as { tree?: GithubTreeEntry[] };
  const paths = filterGithubTree(Array.isArray(tree.tree) ? tree.tree : [], subPath);

  const units: ConnectorUnit[] = [];
  for (const fp of paths) {
    const content = await fetchGithubBlob(owner, name, branch, fp, token);
    if (content == null || !content.trim()) continue;
    units.push({ key: fp, title: fp, contentType: githubContentType(fp), content });
  }
  return units;
}

/**
 * Cheap revision probe for a github source — the branch head commit SHA (one `/commits?per_page=1`
 * call vs. the full tree + up to 150 blob fetches). Lets a resync short-circuit when the branch
 * hasn't moved. Returns {token:null} on a malformed repo, an omitted branch that resolves to the
 * default (handled by the API), or any HTTP/parse failure — so the caller always falls back to a
 * full sync rather than a false "unchanged". `config`: { repo, branch?, token? }.
 */
export async function githubHeadSha(config: Record<string, unknown>): Promise<{ token: string | null }> {
  const repo = typeof config.repo === "string" ? config.repo.trim() : "";
  const m = repo.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!m) return { token: null };
  const [, owner, name] = m;
  const token = typeof config.token === "string" && config.token.trim() ? config.token.trim() : undefined;
  const branch = typeof config.branch === "string" && config.branch.trim() ? config.branch.trim() : "";
  // No `sha` param → GitHub uses the repo's default branch, so an omitted branch just works.
  const q = branch ? `?sha=${encodeURIComponent(branch)}&per_page=1` : "?per_page=1";
  try {
    const res = await fetchWithTimeout(
      `${GITHUB_API}/repos/${owner}/${name}/commits${q}`,
      { headers: githubHeaders(token) },
      GH_TIMEOUT_MS,
    );
    if (!res.ok) return { token: null };
    const arr = (await res.json()) as Array<{ sha?: string }>;
    const sha = Array.isArray(arr) && typeof arr[0]?.sha === "string" ? arr[0].sha : null;
    return { token: sha };
  } catch {
    return { token: null };
  }
}

// ---- Discord connector ----------------------------------------------------

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_TIMEOUT_MS = 10_000;
const DISCORD_DEFAULT_LIMIT = 500;
const DISCORD_HARD_CAP = 5_000; // safety ceiling regardless of config.limit
const DISCORD_MSGS_PER_UNIT = 100; // batch size (readability, not the API page size)
const DISCORD_UNIT_BYTES = 6_000; // ~6KB per unit

/** One Discord message (only the fields we use). */
export type DiscordMessage = {
  id: string;
  content?: string;
  author?: { id?: string; username?: string; bot?: boolean };
  reactions?: Array<{ emoji?: { name?: string | null } }>;
};

/**
 * Pure message batcher (unit-tested without the network): messages MUST be oldest→newest.
 * Renders each non-empty message as "{author}: {content}", skipping empty ones (embed/
 * attachment-only), and packs them into units of ~DISCORD_MSGS_PER_UNIT messages or
 * ~DISCORD_UNIT_BYTES, keyed by "{channelId}:{firstMsgId}".
 */
export function batchDiscordMessages(channelId: string, messages: DiscordMessage[]): ConnectorUnit[] {
  const units: ConnectorUnit[] = [];
  let buf: string[] = [];
  let firstId = "";
  let bytes = 0;
  let part = 1;
  const flush = (): void => {
    if (!buf.length) return;
    units.push({
      key: `${channelId}:${firstId}`,
      title: `Discord #${channelId} (part ${part})`,
      contentType: "text/plain",
      content: buf.join("\n"),
    });
    part++;
    buf = [];
    bytes = 0;
    firstId = "";
  };
  for (const m of messages) {
    const text = (m.content ?? "").trim();
    if (!text) continue; // skip empty / embed-only / attachment-only
    const author = m.author?.username ?? "unknown";
    const line = `${author}: ${text}`;
    if (buf.length && (buf.length >= DISCORD_MSGS_PER_UNIT || bytes + line.length > DISCORD_UNIT_BYTES)) flush();
    if (!buf.length) firstId = m.id;
    buf.push(line);
    bytes += line.length + 1;
  }
  flush();
  return units;
}

/**
 * Discord connector. `config`: { channelId, guildId?, limit? }. Reuses the shared-bot
 * DISCORD_BOT_TOKEN (same env the gateway authenticates with). Pages channel history
 * newest→oldest (100/page) up to the cap (config.limit or 500, hard-capped), reverses to
 * oldest→newest, and batches into readable text units. Attachments/embeds are ignored.
 */
export async function fetchDiscordUnits(config: Record<string, unknown>, ctx?: ConnectorCtx): Promise<ConnectorUnit[]> {
  const channelId = typeof config.channelId === "string" ? config.channelId.trim() : "";
  if (!channelId) throw connectorError("discord connector: config.channelId is required", 400);
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw connectorError("discord connector: DISCORD_BOT_TOKEN not set — Discord channel disabled", 503);
  const cap = Math.min(
    typeof config.limit === "number" && config.limit > 0 ? Math.floor(config.limit) : DISCORD_DEFAULT_LIMIT,
    DISCORD_HARD_CAP,
  );
  const headers = { authorization: `Bot ${token}`, "user-agent": "noola-connector" };

  // Channel probe: a FORUM channel gets the solved-thread distillation path (each resolved
  // post → one canonical Q&A doc) instead of raw message batching — chat logs are poor RAG
  // material; distilled resolutions are what you actually want cited.
  const chRes = await fetchWithTimeout(`${DISCORD_API}/channels/${encodeURIComponent(channelId)}`, { headers }, DISCORD_TIMEOUT_MS);
  if (chRes.status === 401 || chRes.status === 403) {
    throw connectorError("discord connector: bot lacks access to this channel (invite the bot / check permissions)", 403);
  }
  if (chRes.status === 404) throw connectorError("discord connector: channel not found", 404);
  if (chRes.ok) {
    const channel = (await chRes.json()) as {
      type?: number;
      guild_id?: string;
      available_tags?: Array<{ id: string; name: string }>;
    };
    if (channel.type === 15) return fetchDiscordForumUnits(channelId, channel, config, headers, ctx);
  }

  const collected: DiscordMessage[] = [];
  let before: string | undefined;
  while (collected.length < cap) {
    const page = Math.min(100, cap - collected.length);
    const url = `${DISCORD_API}/channels/${encodeURIComponent(channelId)}/messages?limit=${page}${before ? `&before=${before}` : ""}`;
    const res = await fetchWithTimeout(url, { headers }, DISCORD_TIMEOUT_MS);
    if (res.status === 401 || res.status === 403) {
      throw connectorError("discord connector: bot lacks access to this channel (invite the bot / check permissions)", 403);
    }
    if (res.status === 404) throw connectorError("discord connector: channel not found", 404);
    if (!res.ok) throw connectorError(`discord connector: fetch failed (${res.status})`, 502);
    const batch = (await res.json()) as DiscordMessage[];
    if (!Array.isArray(batch) || batch.length === 0) break;
    collected.push(...batch); // newest→oldest within and across pages
    before = batch[batch.length - 1].id; // oldest id seen → page further back
    if (batch.length < page) break; // last page
  }

  collected.reverse(); // oldest→newest for readability
  return batchDiscordMessages(channelId, collected);
}

// ---- Discord forum: solved-thread distillation ----------------------------

const FORUM_THREAD_CAP = 80; // threads per crawl (API-friendly; archived pages up to this)

// Solved-gate configuration (per-source config jsonb), with sensible defaults:
//   solvedTags     — comma-separated keywords matched (substring, case-insensitive) against the
//                    forum's tag names. Default: solved, answered, resolved, done.
//   solvedReaction — comma-separated emoji (glyph or Slack-style name) that mark a thread/answer
//                    as accepted. Default: ✅ ☑️ ✔️.
//   distill        — true (default) distills each solved thread into a canonical Q&A article;
//                    false saves the cleaned raw transcript instead.
const DEFAULT_SOLVED_KEYWORDS = ["solved", "answered", "resolved", "done"];
const DEFAULT_SOLVED_REACTIONS = new Set(["white_check_mark", "ballot_box_with_check", "heavy_check_mark"]);

function solvedKeywords(config: Record<string, unknown>): string[] {
  const raw = typeof config.solvedTags === "string" ? config.solvedTags : "";
  const list = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.length ? list : DEFAULT_SOLVED_KEYWORDS;
}

function solvedReactions(config: Record<string, unknown>): Set<string> {
  const raw = typeof config.solvedReaction === "string" ? config.solvedReaction.trim() : "";
  if (!raw) return DEFAULT_SOLVED_REACTIONS;
  const names = raw.split(",").map((s) => canonicalEmojiName(s)).filter(Boolean);
  return names.length ? new Set(names) : DEFAULT_SOLVED_REACTIONS;
}

function hasSolvedReaction(m: DiscordMessage, accepted: Set<string>): boolean {
  return (m.reactions ?? []).some((r) => accepted.has(canonicalEmojiName(r.emoji?.name ?? "")));
}

interface DiscordThread {
  id: string;
  name?: string;
  parent_id?: string;
  applied_tags?: string[];
  last_message_id?: string | null;
  message_count?: number;
  thread_metadata?: { archive_timestamp?: string };
}

/**
 * Forum-channel connector: enumerate the forum's posts (active + archived), keep only the ones
 * with a RESOLUTION signal, and distill each into one canonical Q&A document.
 *
 * Solved gate (config.solvedOnly, default ON): when the forum has a solved-ish tag (name matching
 * the configured solvedTags keywords), the applied tag is authoritative and cheap. Forums without
 * such tags fall back to a reaction check (configured solvedReaction set) on the thread's messages.
 * Distillation (config.distill, default ON) runs on the tenant's model (resolveModelDriver) with a
 * deterministic extractive fallback (starter question + accepted/last substantive answer) so it
 * works keyless/air-gapped; distill OFF stores the cleaned raw transcript instead.
 * Units are keyed thread:{id}:{lastMessageId} — an unchanged thread emits keep:true (no message
 * fetch, no model call on re-crawls); a thread that grew re-distills under a new key.
 */
async function fetchDiscordForumUnits(
  channelId: string,
  channel: { guild_id?: string; available_tags?: Array<{ id: string; name: string }> },
  config: Record<string, unknown>,
  headers: Record<string, string>,
  ctx?: ConnectorCtx,
): Promise<ConnectorUnit[]> {
  const guildId = (typeof config.guildId === "string" && config.guildId.trim()) || channel.guild_id || "";
  const solvedOnly = config.solvedOnly !== false; // default ON
  const distill = config.distill !== false; // default ON
  const keywords = solvedKeywords(config);
  const acceptedReactions = solvedReactions(config);
  const solvedTagIds = new Set(
    (channel.available_tags ?? [])
      .filter((t) => keywords.some((k) => t.name.toLowerCase().includes(k)))
      .map((t) => t.id),
  );
  const useTagGate = solvedTagIds.size > 0;

  // Active threads are only listable guild-wide; archived ones page per-channel.
  const threads: DiscordThread[] = [];
  const seenThreads = new Set<string>();
  const push = (t: DiscordThread): void => {
    if (t.id && !seenThreads.has(t.id)) { seenThreads.add(t.id); threads.push(t); }
  };
  if (guildId) {
    const r = await fetchWithTimeout(`${DISCORD_API}/guilds/${encodeURIComponent(guildId)}/threads/active`, { headers }, DISCORD_TIMEOUT_MS);
    if (r.ok) {
      const j = (await r.json()) as { threads?: DiscordThread[] };
      for (const t of j.threads ?? []) if (t.parent_id === channelId) push(t);
    }
  }
  let before: string | undefined;
  while (threads.length < FORUM_THREAD_CAP) {
    const url = `${DISCORD_API}/channels/${encodeURIComponent(channelId)}/threads/archived/public?limit=100${before ? `&before=${encodeURIComponent(before)}` : ""}`;
    const r = await fetchWithTimeout(url, { headers }, DISCORD_TIMEOUT_MS);
    if (!r.ok) break;
    const j = (await r.json()) as { threads?: DiscordThread[]; has_more?: boolean };
    const batch = j.threads ?? [];
    if (!batch.length) break;
    for (const t of batch) push(t);
    before = batch[batch.length - 1]?.thread_metadata?.archive_timestamp;
    if (!j.has_more || !before) break;
  }

  const units: ConnectorUnit[] = [];
  for (const t of threads.slice(0, FORUM_THREAD_CAP)) {
    if (solvedOnly && useTagGate && !(t.applied_tags ?? []).some((id) => solvedTagIds.has(id))) continue;
    const key = `thread:${t.id}:${t.last_message_id ?? String(t.message_count ?? 0)}`;
    const title = t.name?.trim() || `Thread ${t.id}`;
    if (ctx?.existingKeys.has(key)) {
      units.push({ key, title, contentType: "text/markdown", content: "", keep: true });
      continue;
    }
    const mr = await fetchWithTimeout(`${DISCORD_API}/channels/${encodeURIComponent(t.id)}/messages?limit=100`, { headers }, DISCORD_TIMEOUT_MS);
    if (!mr.ok) continue;
    const msgs = ((await mr.json()) as DiscordMessage[]).reverse(); // oldest→newest
    if (solvedOnly && !useTagGate && !msgs.some((m) => hasSolvedReaction(m, acceptedReactions))) continue;
    const distilled = distill
      ? await distillThread(title, msgs, acceptedReactions, ctx?.tenantId)
      : rawThreadTranscript(title, msgs);
    if (!distilled) continue;
    const provenance = guildId ? `\n\n_Source: https://discord.com/channels/${guildId}/${t.id}_` : "";
    units.push({ key, title, contentType: "text/markdown", content: distilled + provenance });
  }
  return units;
}

const DISTILL_PROMPT =
  "You are building a support knowledge base from a resolved community thread. Distill it into a " +
  "canonical Q&A article: a one-line question as a '## ' markdown heading, then a clear, " +
  "self-contained answer (2-8 sentences) covering the accepted solution — include exact steps, " +
  "commands, or settings mentioned. Ignore chit-chat, +1s and dead ends. No preamble.";

/** Cleaned raw transcript (distill OFF): the thread as attributed markdown, chit-chat and all —
 *  for teams that prefer verbatim history over a distilled Q&A. */
function rawThreadTranscript(title: string, msgs: DiscordMessage[]): string | null {
  const substantive = msgs.filter((m) => (m.content ?? "").trim());
  if (!substantive.length) return null;
  const lines = substantive.map((m) => `**${m.author?.username ?? "user"}:** ${(m.content ?? "").trim()}`);
  return [`## ${title}`, "", lines.join("\n\n")].join("\n").slice(0, 20000);
}

/** Distill one resolved thread into a Q&A article. Tenant model when available; deterministic
 *  extractive fallback (starter question + the accepted/last substantive answer) otherwise. */
async function distillThread(
  title: string,
  msgs: DiscordMessage[],
  acceptedReactions: Set<string>,
  tenantId?: string,
): Promise<string | null> {
  const substantive = msgs.filter((m) => (m.content ?? "").trim());
  if (!substantive.length) return null;

  if (tenantId) {
    const transcript = `Thread title: ${title}\n\n${substantive
      .map((m) => `${m.author?.username ?? "user"}: ${(m.content ?? "").trim()}`)
      .join("\n")}`.slice(0, 12000);
    try {
      const driver = await resolveModelDriver(tenantId);
      if (typeof driver.complete === "function") {
        const out = (await driver.complete(DISTILL_PROMPT, transcript)).trim();
        if (out) return out;
      }
    } catch {
      /* hosted model failed → extractive fallback below */
    }
  }

  // Extractive: question = the starter message; answer = an accepted-reaction reply from someone
  // else, else their last substantive (≥40 chars) reply. No answer → thread isn't KB material.
  const starter = substantive[0];
  const starterAuthor = starter.author?.id ?? starter.author?.username;
  const others = substantive.filter((m) => (m.author?.id ?? m.author?.username) !== starterAuthor);
  const accepted = [...others].reverse().find((m) => hasSolvedReaction(m, acceptedReactions));
  const answer = accepted ?? [...others].reverse().find((m) => (m.content ?? "").trim().length >= 40);
  if (!answer) return null;
  const clipText = (s: string, n: number): string => s.replace(/\s+/g, " ").trim().slice(0, n);
  return [
    `## ${title || clipText(starter.content ?? "", 120)}`,
    "",
    `**Question:** ${clipText(starter.content ?? "", 600)}`,
    "",
    `**Answer:** ${clipText(answer.content ?? "", 1200)}`,
  ].join("\n");
}

// ---- Sync engine ----------------------------------------------------------

async function setStatus(
  tenantId: string,
  id: string,
  fields: { status: string; last_error?: string | null; doc_count?: number; touchSynced?: boolean; syncToken?: string | null; crawlLog?: CrawlLog | null },
): Promise<void> {
  await withTenant(tenantId, async (c) => {
    await c.query(
      `UPDATE sources SET
         status = $2,
         last_error = COALESCE($3, last_error),
         doc_count = COALESCE($4, doc_count),
         last_synced_at = CASE WHEN $5 THEN now() ELSE last_synced_at END,
         last_sync_token = COALESCE($6, last_sync_token),
         crawl_log = COALESCE($7::jsonb, crawl_log)
       WHERE id = $1`,
      [id, fields.status, fields.last_error ?? null, fields.doc_count ?? null, fields.touchSynced ?? false, fields.syncToken ?? null,
       fields.crawlLog ? JSON.stringify(fields.crawlLog) : null],
    );
    // last_error must be clearable to NULL on success; COALESCE won't null it, so
    // handle the explicit-clear case separately.
    if (fields.status === "ok") {
      await c.query("UPDATE sources SET last_error = NULL WHERE id = $1", [id]);
    }
  });
}

/** Emit the outbox event so the edge relays it and the UI updates live (poll/subscribe).
 *  Same transactional-outbox pattern as ingest/autoreply, on the per-tenant subject. */
async function emitSourceSynced(
  tenantId: string,
  sourceId: string,
  status: string,
  docCount: number,
): Promise<void> {
  await withTenant(tenantId, async (c) => {
    const envelope = {
      id: sourceId,
      type: EVENT_TYPES.sourceSynced,
      tenantId,
      occurredAt: new Date().toISOString(),
      data: { sourceId, status, docCount },
    };
    await c.query(
      "INSERT INTO outbox (tenant_id, event_type, subject, payload) VALUES (current_tenant(), $1, 'noola.events.' || current_tenant(), $2::jsonb)",
      [EVENT_TYPES.sourceSynced, JSON.stringify(envelope)],
    );
  });
}

export interface SyncResult {
  status: "ok" | "error";
  docCount: number;
  /** Incremental diff (added/updated/unchanged/removed) — present on a successful sync. */
  diff?: SyncDiff;
  error?: string;
}

/**
 * Run a source's connector and ingest its units, replacing the source's prior docs.
 * Marks status='syncing' (the caller may have kicked this fire-and-forget), then on
 * success status='ok' + doc_count + last_synced_at, on failure status='error' +
 * last_error. Emits noola.source.synced either way. `connector` override is a test seam;
 * production resolves the connector from the registry by kind.
 */
export async function syncSource(
  tenantId: string,
  sourceId: string,
  connector?: Connector,
  precheck?: Precheck,
): Promise<SyncResult | null> {
  const src = await getSource(tenantId, sourceId);
  if (!src) return null;

  await setStatus(tenantId, sourceId, { status: "syncing" });
  // Telemetry sink: filled by the connector as it fetches, persisted after so the source detail
  // can show what this sync actually did. Stays null on the short-circuit path (nothing crawled),
  // so we never overwrite the last real crawl log with an empty one.
  let crawl: CrawlLog | null = null;
  try {
    // Smart-resync short-circuit: probe the upstream revision cheaply (github head SHA). If it matches
    // the token from our last successful sync AND we already hold docs, skip the whole fetch+diff and
    // just touch last_synced_at — nothing moved. `syncToken` (the fresh revision) is also carried into
    // the full-sync path below so a real sync records the revision it captured.
    const pre = precheck ?? PRECHECKS[src.kind];
    let syncToken: string | null = null;
    if (pre) {
      try {
        syncToken = (await pre(src.config)).token;
      } catch {
        syncToken = null; // precheck failure → fall through to a full sync
      }
      if (syncToken && src.last_sync_token && syncToken === src.last_sync_token && src.doc_count > 0) {
        await setStatus(tenantId, sourceId, { status: "ok", touchSynced: true, syncToken });
        await emitSourceSynced(tenantId, sourceId, "ok", src.doc_count);
        void import("./automations.js")
          .then((m) => m.emitDomainEvent(tenantId, "source.synced", {
            sourceId, sourceName: src.label, docCount: src.doc_count,
            added: 0, updated: 0, removed: 0, unchanged: src.doc_count,
          }))
          .catch(() => {});
        const diff: SyncDiff = { added: 0, updated: 0, unchanged: src.doc_count, removed: 0, total: src.doc_count, failed: 0 };
        return { status: "ok", docCount: src.doc_count, diff };
      }
    }

    const fn = connector ?? CONNECTORS[src.kind];
    if (!fn) throw new Error(`unknown source kind: ${src.kind}`);
    // Connector ctx: stored doc keys let incremental connectors emit keep:true for unchanged
    // units (the discord forum path skips message fetch + model distillation on those).
    const existingKeys = await withTenant(tenantId, async (c) => {
      const r = await c.query("SELECT source_key FROM documents WHERE source_id = $1 AND source_key IS NOT NULL", [sourceId]);
      return new Set((r.rows as Array<{ source_key: string }>).map((x) => x.source_key));
    });
    crawl = newCrawlLog();
    const units = await fn(src.config, { tenantId, existingKeys, crawl });

    // Incremental resync: diff the fetched units against what's stored (by key + content hash) and
    // only re-embed/re-index what changed — unchanged docs (and their embeddings) are left alone,
    // and the source is never emptied up-front, so a mid-sync failure keeps the last-good docs.
    const diff = await syncDocuments(tenantId, sourceId, units);

    crawl.diff = { added: diff.added, updated: diff.updated, unchanged: diff.unchanged, removed: diff.removed, total: diff.total, failed: diff.failed };
    crawl.ok = true;
    crawl.finishedAt = new Date().toISOString();
    await setStatus(tenantId, sourceId, { status: "ok", doc_count: diff.total, touchSynced: true, syncToken, crawlLog: crawl });
    await emitSourceSynced(tenantId, sourceId, "ok", diff.total);
    // Also fire the domain event so tenant Studio flows can react to a completed sync. The diff is
    // surfaced in ctx so a flow can branch on whether anything actually changed. Fire-and-forget.
    void import("./automations.js")
      .then((m) => m.emitDomainEvent(tenantId, "source.synced", {
        sourceId, sourceName: src.label, docCount: diff.total,
        added: diff.added, updated: diff.updated, removed: diff.removed, unchanged: diff.unchanged,
      }))
      .catch(() => {});
    return { status: "ok", docCount: diff.total, diff };
  } catch (err) {
    const msg = (err as Error).message ?? "sync failed";
    if (crawl) {
      crawl.ok = false;
      crawl.error = msg;
      crawl.finishedAt = new Date().toISOString();
    }
    await setStatus(tenantId, sourceId, { status: "error", last_error: msg, crawlLog: crawl });
    await emitSourceSynced(tenantId, sourceId, "error", 0);
    return { status: "error", docCount: 0, error: msg };
  }
}

// ── Scheduled source re-crawl ─────────────────────────────────────────────────
// Per-minute sweep (wired in server.ts, mirrors runScheduledAutomations): re-sync every source
// whose auto-refresh interval has elapsed, across all tenants. Cross-tenant discovery uses the
// BYPASSRLS relayPool (read-only); the actual sync is tenant-scoped via syncSource. Skips sources
// mid-sync and never lets one tenant's failure stop the others.

export interface SchedulerLog {
  info?: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
}

let refreshRunning = false;

/** True when a source with `intervalMinutes` last synced at `lastSyncedAt` is due again now. A
 *  source that has never synced (null) is due immediately. */
export function isRefreshDue(lastSyncedAt: string | null, intervalMinutes: number | null, now: number): boolean {
  if (!intervalMinutes || intervalMinutes <= 0) return false;
  if (!lastSyncedAt) return true;
  return now - new Date(lastSyncedAt).getTime() >= intervalMinutes * 60_000;
}

export async function runScheduledSourceRefresh(log?: SchedulerLog): Promise<void> {
  if (refreshRunning) return; // previous tick still in flight → skip
  refreshRunning = true;
  try {
    const rows = await relayPool.query(
      `SELECT tenant_id, id, last_synced_at, refresh_interval_minutes
         FROM sources
        WHERE refresh_interval_minutes IS NOT NULL AND status <> 'syncing'`,
    );
    const now = Date.now();
    const due = rows.rows.filter((r) =>
      isRefreshDue(
        r.last_synced_at ? new Date(r.last_synced_at as string).toISOString() : null,
        r.refresh_interval_minutes as number | null,
        now,
      ),
    );
    for (const r of due) {
      try {
        const res = await syncSource(r.tenant_id as string, r.id as string);
        log?.info?.({ sourceId: r.id, status: res?.status, docs: res?.docCount }, "scheduled source refresh");
      } catch (e) {
        log?.error?.({ err: e, sourceId: r.id }, "scheduled source refresh failed");
      }
    }
  } catch (e) {
    log?.error?.({ err: e }, "source refresh sweep failed");
  } finally {
    refreshRunning = false;
  }
}
