-- Repair status_category drift + normalize the phantom 'solved' status.
--
-- (1) setTicketStatus historically wrote status + closed_at but NOT status_category, so every
--     console-closed ticket kept status_category='open'. Reporting/SLA that read status_category
--     were therefore wrong. Backfill both directions to match status. Idempotent.
UPDATE tickets SET status_category = 'closed'
 WHERE status = 'closed' AND status_category IS DISTINCT FROM 'closed';
UPDATE tickets SET status_category = 'open'
 WHERE status = 'open' AND status_category IS DISTINCT FROM 'open';

-- (2) The old Discord thread-lock handler wrote status='solved' — a value no list query recognizes
--     (open views match 'open', the closed view 'closed'; there is no CHECK constraint), so those
--     tickets vanished from BOTH queues, kept closed_at NULL, and never emitted ticket.closed. Make
--     them real closes so they surface in the closed view and carry a resolution time. Idempotent.
UPDATE tickets SET status = 'closed', status_category = 'closed',
                   closed_at = COALESCE(closed_at, updated_at, now())
 WHERE status = 'solved';
