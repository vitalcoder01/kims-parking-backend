-- AlterTable
ALTER TABLE "visitors" ADD COLUMN     "driverId" TEXT,
ADD COLUMN     "retrievalRequested" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "visitors_driverId_idx" ON "visitors"("driverId");

-- AddForeignKey
ALTER TABLE "visitors" ADD CONSTRAINT "visitors_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
