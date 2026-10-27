-- Contact tags: free-form labels on a person ("DevConf 2026", "webinar-06", "VIP"). Multi-valued
-- (someone met at two events carries both), so not an attribute. The typical writer is a CSV import
-- tagged with the event it came from; the filter builder / broadcasts target them ("Tag is …").
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS contacts_tags_gin ON contacts USING gin (tags);
