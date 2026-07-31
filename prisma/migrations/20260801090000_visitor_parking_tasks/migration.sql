-- Visitors run through ParkingTask, the same table staff use, so that
-- scheduling, ownership, recovery, driver assignment and notifications are one
-- code path rather than two implementations that drift.
--
-- A visitor is not a User, so doctorId has to become nullable and a visitorId
-- added alongside it. Exactly one of the two is set on any row.
ALTER TABLE "parking_tasks" ALTER COLUMN "doctorId" DROP NOT NULL;
ALTER TABLE "parking_tasks" ADD COLUMN IF NOT EXISTS "visitorId" INTEGER;

ALTER TABLE "parking_tasks"
  ADD CONSTRAINT "parking_tasks_visitorId_fkey"
  FOREIGN KEY ("visitorId") REFERENCES "visitors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Structural, not conventional: a row belonging to nobody, or to both a doctor
-- and a visitor, is meaningless and every reader would have to guess.
ALTER TABLE "parking_tasks"
  ADD CONSTRAINT "parking_tasks_one_owner_chk"
  CHECK (("doctorId" IS NOT NULL AND "visitorId" IS NULL)
      OR ("doctorId" IS NULL AND "visitorId" IS NOT NULL));

-- "At most one current session per visitor", mirroring the doctor index.
-- The existing doctor index keeps working untouched: Postgres treats NULLs as
-- distinct in a unique index, so visitor rows (doctorId NULL) never collide
-- with each other there.
CREATE UNIQUE INDEX IF NOT EXISTS "parking_tasks_visitor_current_idx"
  ON "parking_tasks"("visitorId") WHERE "isCurrent" = true AND "visitorId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "parking_tasks_visitorId_idx" ON "parking_tasks"("visitorId");
