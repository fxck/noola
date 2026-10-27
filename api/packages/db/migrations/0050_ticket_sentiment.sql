-- Per-ticket customer sentiment (positive / neutral / negative), stamped by a keyword classifier on
-- each inbound customer message. NULL = not yet classified. Advisory signal for triage + analytics.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sentiment text;
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_sentiment_ck;
ALTER TABLE tickets ADD CONSTRAINT tickets_sentiment_ck
  CHECK (sentiment IS NULL OR sentiment IN ('positive', 'neutral', 'negative'));
