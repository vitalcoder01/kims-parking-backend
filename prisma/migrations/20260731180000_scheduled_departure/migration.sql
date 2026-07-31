-- Scheduled departures.
--
-- plannedDepartureAt is the absolute time the doctor intends to leave;
-- retrievalReadyAt is that minus the configured lead time, i.e. when the
-- request stops being informational and becomes actionable. Both are stored
-- rather than derived so a sweep can query them directly, and so that changing
-- the lead-time setting later cannot move the deadline of a request already
-- in flight.
ALTER TABLE "parking_tasks" ADD COLUMN IF NOT EXISTS "plannedDepartureAt" TIMESTAMP(3);
ALTER TABLE "parking_tasks" ADD COLUMN IF NOT EXISTS "retrievalReadyAt"  TIMESTAMP(3);

-- The promote-to-READY sweep filters on this on every tick.
CREATE INDEX IF NOT EXISTS "parking_tasks_retrievalReadyAt_idx" ON "parking_tasks"("retrievalReadyAt");

-- Existing open retrievals were created before scheduling existed: they were
-- actionable the moment they were raised, so backfill them as already ready
-- rather than leaving them NULL and having the UI decide what that means.
UPDATE "parking_tasks"
   SET "plannedDepartureAt" = COALESCE("requestedAt", "createdAt") + (COALESCE("eta", 0) || ' minutes')::interval,
       "retrievalReadyAt"   = COALESCE("requestedAt", "createdAt")
 WHERE "type" = 'retrieve' AND "retrievalReadyAt" IS NULL;
