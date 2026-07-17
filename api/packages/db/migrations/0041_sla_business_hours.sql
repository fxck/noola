-- SLA business hours — the documented upgrade to the first-cut SLA. When business_hours_enabled,
-- SLA target clocks tick ONLY during the configured weekly working window, so a ticket opened
-- Friday evening isn't "breached" by Monday morning. A fixed weekly schedule (no DST):
-- tz_offset_mins converts UTC → the workspace's wall clock; workdays is a set of weekday numbers
-- (0=Sun … 6=Sat); day_start_min / day_end_min bound the working window in minutes past local
-- midnight. Computation stays in the app (no stored due dates), so changing the schedule
-- re-derives every ticket's state.
ALTER TABLE sla_policies ADD COLUMN IF NOT EXISTS business_hours_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE sla_policies ADD COLUMN IF NOT EXISTS tz_offset_mins integer NOT NULL DEFAULT 0;
ALTER TABLE sla_policies ADD COLUMN IF NOT EXISTS workdays integer[] NOT NULL DEFAULT '{1,2,3,4,5}';
ALTER TABLE sla_policies ADD COLUMN IF NOT EXISTS day_start_min integer NOT NULL DEFAULT 540;  -- 09:00
ALTER TABLE sla_policies ADD COLUMN IF NOT EXISTS day_end_min integer NOT NULL DEFAULT 1020;   -- 17:00
