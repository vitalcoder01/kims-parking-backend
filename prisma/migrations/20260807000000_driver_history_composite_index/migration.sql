-- The driver app's job-history fetch (GET /tasks?driverId=X&history=true,
-- used for "completed today" and past jobs) is WHERE driverId = ? ORDER BY
-- createdAt DESC LIMIT 200. Only a plain index on driverId existed, so
-- Postgres could filter with it but still had to sort every matching row in
-- memory afterward — the same gap the doctorId composite index already
-- closed for the doctor-facing equivalent of this query. This closes it for
-- drivers too.
CREATE INDEX IF NOT EXISTS "parking_tasks_driverId_createdAt_idx"
ON "parking_tasks" ("driverId", "createdAt");
