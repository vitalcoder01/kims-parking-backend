-- CreateIndex
CREATE INDEX "parking_slots_doctorId_status_idx" ON "parking_slots"("doctorId", "status");

-- CreateIndex
CREATE INDEX "parking_tasks_slotId_idx" ON "parking_tasks"("slotId");
