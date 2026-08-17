-- Index and autovacuum housekeeping. No data is touched.

-- 1. Two single-column indexes that were already covered.
--
-- Postgres can use the leading column of a composite index on its own, so
-- parking_tasks(doctorId) and parking_tasks(driverId) added nothing that
-- parking_tasks(doctorId, createdAt) and parking_tasks(driverId, createdAt)
-- did not already serve. They were not free: every task update maintained
-- them, and the GPS pings written to this table while a driver is en route
-- make updates by far its hottest write. parking_tasks was carrying 360 kB of
-- indexes over 144 kB of actual data.
DROP INDEX IF EXISTS "parking_tasks_doctorId_idx";
DROP INDEX IF EXISTS "parking_tasks_driverId_idx";

-- 2. An index on a column with one value.
--
-- notifications.read has never been true for any row, and this index has
-- never been chosen by a query (idx_scan = 0 in production).
DROP INDEX IF EXISTS "notifications_read_idx";

-- 3. Autovacuum for small, hot tables.
--
-- Autovacuum triggers at threshold + scale_factor * rowcount, and the default
-- scale factor is 0.2. On a table holding 3 rows that means it effectively
-- never runs: production had `settings` sitting at 21 dead rows against 3
-- live, device_tokens at 21 against 11, attendance at 30 against 29. Every
-- sequential scan of those tables reads the dead rows too, and these are
-- exactly the tables the app reads most often.
--
-- Setting scale_factor to 0 makes the threshold absolute, so these vacuum
-- after a fixed 50 dead rows regardless of how small they stay.
ALTER TABLE "settings"      SET (autovacuum_vacuum_scale_factor = 0, autovacuum_vacuum_threshold = 50);
ALTER TABLE "device_tokens" SET (autovacuum_vacuum_scale_factor = 0, autovacuum_vacuum_threshold = 50);
ALTER TABLE "attendance"    SET (autovacuum_vacuum_scale_factor = 0, autovacuum_vacuum_threshold = 50);
