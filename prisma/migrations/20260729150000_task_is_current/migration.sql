-- Add the "cancelled" terminal status and the isCurrent flag that makes a
-- doctor's live status a single, unambiguous row instead of "search history
-- for the most recent non-completed one." Postgres won't let a new enum
-- value be used in the same transaction it's added in, so the data cleanup
-- and the partial unique index that depend on 'cancelled' live in the next
-- migration instead.
ALTER TYPE "TaskStatus" ADD VALUE IF NOT EXISTS 'cancelled';

ALTER TABLE "parking_tasks" ADD COLUMN "isCurrent" BOOLEAN NOT NULL DEFAULT true;
