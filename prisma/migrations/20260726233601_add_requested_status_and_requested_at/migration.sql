-- AlterEnum
ALTER TYPE "TaskStatus" ADD VALUE 'requested';

-- AlterTable
ALTER TABLE "parking_tasks" ADD COLUMN     "requestedAt" TIMESTAMP(3);
