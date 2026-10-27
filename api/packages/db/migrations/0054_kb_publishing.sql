-- KB-CMS lifecycle — give articles a publish state, an audience, and a stable public URL slug so a
-- subset of the knowledge base can front a public help center. `status` gates draft vs live;
-- `visibility` gates who can see a live article (internal = agent grounding only; public = also on
-- the help center); `slug` is the public URL key. Existing articles default to published+internal, so
-- nothing becomes public implicitly and agent grounding is unchanged — an admin opts an article into
-- the help center by flipping visibility to 'public'.
ALTER TABLE kb_articles ADD COLUMN IF NOT EXISTS status       text NOT NULL DEFAULT 'published';
ALTER TABLE kb_articles ADD COLUMN IF NOT EXISTS visibility   text NOT NULL DEFAULT 'internal';
ALTER TABLE kb_articles ADD COLUMN IF NOT EXISTS slug         text;
ALTER TABLE kb_articles ADD COLUMN IF NOT EXISTS published_at timestamptz;

ALTER TABLE kb_articles DROP CONSTRAINT IF EXISTS kb_articles_status_ck;
ALTER TABLE kb_articles ADD CONSTRAINT kb_articles_status_ck CHECK (status IN ('draft', 'published'));
ALTER TABLE kb_articles DROP CONSTRAINT IF EXISTS kb_articles_visibility_ck;
ALTER TABLE kb_articles ADD CONSTRAINT kb_articles_visibility_ck CHECK (visibility IN ('internal', 'public'));

-- Backfill a slug for pre-existing rows: slugified title + a short id suffix to guarantee uniqueness
-- without a dedupe pass. New articles get a clean, collision-checked slug from the app layer.
UPDATE kb_articles
   SET slug = NULLIF(trim(both '-' from regexp_replace(lower(title), '[^a-z0-9]+', '-', 'g')), '') || '-' || left(id::text, 8)
 WHERE slug IS NULL;
UPDATE kb_articles SET slug = 'article-' || left(id::text, 8) WHERE slug IS NULL OR slug LIKE '-%';

-- Published articles get a published_at stamp (drives "last updated" on the help center).
UPDATE kb_articles SET published_at = created_at WHERE status = 'published' AND published_at IS NULL;

-- One slug per tenant (the public help-center URL key).
CREATE UNIQUE INDEX IF NOT EXISTS kb_articles_slug_uq ON kb_articles (tenant_id, slug) WHERE slug IS NOT NULL;
-- Fast public-surface filter (published + public, per tenant).
CREATE INDEX IF NOT EXISTS kb_articles_public_idx ON kb_articles (tenant_id, status, visibility);
