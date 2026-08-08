-- Repeating "still needs a driver" reminder for a freshly-created park
-- ticket (staff key-collection or a visitor check-in — both are this same
-- table). Separate from the existing escalatedAt/valetClaimedAt ladder,
-- which is a one-time grace-period escalation used for retrieval requests
-- and driver rejections and must keep behaving exactly as it does today.
ALTER TABLE "parking_tasks" ADD COLUMN IF NOT EXISTS "lastDriverReminderAt" TIMESTAMP(3);
ALTER TABLE "parking_tasks" ADD COLUMN IF NOT EXISTS "driverReminderSilencedAt" TIMESTAMP(3);
