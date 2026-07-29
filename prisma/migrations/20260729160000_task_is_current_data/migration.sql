-- Retire the known zombie duplicates from the earlier double-tap bug
-- (3x "TEST CAR1083" rows stuck at assigned/no-driver forever) — they were
-- masking real, later, completed tasks on the doctor's Vehicle Status card.
UPDATE "parking_tasks"
SET status = 'cancelled', "completedAt" = COALESCE("completedAt", now())
WHERE "carNumber" = 'TEST CAR1083' AND status = 'assigned' AND "driverId" IS NULL;

-- Collapse every doctor down to exactly one isCurrent=true row: the
-- genuinely most recent one (by createdAt, id as tiebreaker). Everything
-- older becomes retired history — never deleted, just no longer "the" row.
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY "doctorId" ORDER BY "createdAt" DESC, id DESC
  ) AS rn
  FROM "parking_tasks"
)
UPDATE "parking_tasks" pt
SET "isCurrent" = false
FROM ranked
WHERE pt.id = ranked.id AND ranked.rn > 1;

-- The actual guarantee: the database itself refuses a second isCurrent=true
-- row per doctor, so the "which task is the real one" bug class becomes
-- structurally impossible rather than something application code has to
-- keep getting right.
CREATE UNIQUE INDEX IF NOT EXISTS "parking_tasks_doctor_current_idx"
  ON "parking_tasks"("doctorId") WHERE "isCurrent" = true;

CREATE INDEX IF NOT EXISTS "parking_tasks_doctorId_createdAt_idx"
  ON "parking_tasks"("doctorId", "createdAt");
