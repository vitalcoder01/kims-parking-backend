-- Valet aborted a park job after the key was already handed over — the
-- driver brings the car back instead of parking it.
ALTER TABLE "parking_tasks" ADD COLUMN "recalledAt" TIMESTAMP(3);

-- A driver can only ever be on ONE live job at a time. Application code
-- already tried to maintain this, but nothing enforced it: two concurrent
-- assignments (two valets, or a task + a visitor pickup) could both point
-- at the same driver and both succeed. 'delivered' is deliberately NOT in
-- this set — a retrieve task sitting at 'delivered' has already freed its
-- driver and is only awaiting the valet's confirmation.
--
-- Retire any pre-existing violations first (keep the newest, cancel the
-- rest) so the index can actually be created.
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
           PARTITION BY "driverId"
           ORDER BY "assignedAt" DESC NULLS LAST, id DESC
         ) AS rn
  FROM "parking_tasks"
  WHERE "driverId" IS NOT NULL
    AND status IN ('assigned', 'key_collected', 'in_transit')
)
UPDATE "parking_tasks" pt
SET status = 'cancelled', "completedAt" = COALESCE(pt."completedAt", now())
FROM ranked
WHERE pt.id = ranked.id AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "parking_tasks_driver_active_idx"
  ON "parking_tasks"("driverId")
  WHERE "driverId" IS NOT NULL
    AND status IN ('assigned', 'key_collected', 'in_transit');
