-- Per-sync crawl telemetry for the live-sources connectors (url/web especially): which strategy
-- the crawl took (sitemap / llms.txt manifest / same-origin link-follow / single page), per-page
-- outcomes (ingested markdown vs stripped HTML vs failed), the llms.txt discovery result, and
-- byte/page counts. Overwritten each sync; null until the first sync on this schema. Powers the
-- source-detail "Crawl log" panel so an operator can SEE why a crawl fetched N pages (e.g. the
-- prod "5 vs 338" divergence) instead of guessing. Detail-only (never selected in the list query).
ALTER TABLE sources ADD COLUMN IF NOT EXISTS crawl_log jsonb;
