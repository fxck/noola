-- An AI draft whose note or no-reply tags are malformed waits in the approval queue, never sent as it is.
ALTER TABLE autoreply_queue DROP CONSTRAINT IF EXISTS autoreply_queue_reason_ck;
ALTER TABLE autoreply_queue ADD CONSTRAINT autoreply_queue_reason_ck
  CHECK (reason IN ('suggest_only', 'weak_retrieval', 'low_confidence', 'malformed_output'));
