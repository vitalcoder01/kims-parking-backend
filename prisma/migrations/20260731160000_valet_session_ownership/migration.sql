-- Arrival request: broadcast to all valets until one accepts.
ALTER TABLE "arrival_notices" ADD COLUMN "ownerValetId" INTEGER;
ALTER TABLE "arrival_notices" ADD COLUMN "arrivalAcceptedAt" TIMESTAMP(3);
CREATE INDEX "arrival_notices_ownerValetId_idx" ON "arrival_notices"("ownerValetId");
ALTER TABLE "arrival_notices" ADD CONSTRAINT "arrival_notices_ownerValetId_fkey"
  FOREIGN KEY ("ownerValetId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Parking session ownership. arrivalOwner is written once and never
-- overwritten; retrievalOwner records who actually ran the departure leg so
-- a recovery is auditable rather than silently rewriting history.
ALTER TABLE "parking_tasks" ADD COLUMN "arrivalOwnerValetId" INTEGER;
ALTER TABLE "parking_tasks" ADD COLUMN "arrivalAcceptedAt" TIMESTAMP(3);
ALTER TABLE "parking_tasks" ADD COLUMN "retrievalOwnerValetId" INTEGER;
ALTER TABLE "parking_tasks" ADD COLUMN "retrievalAcceptedAt" TIMESTAMP(3);
ALTER TABLE "parking_tasks" ADD COLUMN "retrievalOwnershipSource" TEXT;
ALTER TABLE "parking_tasks" ADD COLUMN "ownerNotifiedAt" TIMESTAMP(3);
ALTER TABLE "parking_tasks" ADD COLUMN "recoveryBroadcastAt" TIMESTAMP(3);

ALTER TABLE "parking_tasks" ADD CONSTRAINT "parking_tasks_arrivalOwnerValetId_fkey"
  FOREIGN KEY ("arrivalOwnerValetId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "parking_tasks" ADD CONSTRAINT "parking_tasks_retrievalOwnerValetId_fkey"
  FOREIGN KEY ("retrievalOwnerValetId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Existing rows: the valet already recorded as owner was the arrival owner.
UPDATE "parking_tasks" SET "arrivalOwnerValetId" = "valetId" WHERE "valetId" IS NOT NULL;

CREATE INDEX "parking_tasks_arrivalOwnerValetId_idx" ON "parking_tasks"("arrivalOwnerValetId");
CREATE INDEX "parking_tasks_retrievalOwnerValetId_idx" ON "parking_tasks"("retrievalOwnerValetId");
