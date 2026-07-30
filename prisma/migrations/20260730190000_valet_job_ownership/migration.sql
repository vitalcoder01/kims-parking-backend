-- Which valet owns a job. Only the owner is alarmed when a job needs
-- attention (driver rejected / never accepted), instead of waking every
-- valet on shift. Nullable: a retrieval is created by the doctor and has no
-- owner until a valet first acts on it.
ALTER TABLE "parking_tasks" ADD COLUMN "valetId" INTEGER;
ALTER TABLE "parking_tasks" ADD COLUMN "valetClaimedAt" TIMESTAMP(3);
-- Set once a stalled job has been escalated past its owner, so escalation
-- fires exactly once per stall rather than on every sweep.
ALTER TABLE "parking_tasks" ADD COLUMN "escalatedAt" TIMESTAMP(3);

ALTER TABLE "visitors" ADD COLUMN "valetId" INTEGER;
ALTER TABLE "visitors" ADD COLUMN "valetClaimedAt" TIMESTAMP(3);
ALTER TABLE "visitors" ADD COLUMN "escalatedAt" TIMESTAMP(3);

CREATE INDEX "parking_tasks_valetId_idx" ON "parking_tasks"("valetId");
CREATE INDEX "visitors_valetId_idx" ON "visitors"("valetId");

ALTER TABLE "parking_tasks" ADD CONSTRAINT "parking_tasks_valetId_fkey"
  FOREIGN KEY ("valetId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "visitors" ADD CONSTRAINT "visitors_valetId_fkey"
  FOREIGN KEY ("valetId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
