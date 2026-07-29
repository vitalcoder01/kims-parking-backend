-- New intermediate state between "driver dropped the car at the valet
-- counter" and "owner confirmed to have taken it" for both retrieve-type
-- parking tasks and visitors.
ALTER TYPE "TaskStatus" ADD VALUE IF NOT EXISTS 'delivered';
ALTER TYPE "VisitorStatus" ADD VALUE IF NOT EXISTS 'delivered';
