CREATE TABLE "arrival_notices" (
    "id" SERIAL NOT NULL,
    "doctorId" INTEGER NOT NULL,
    "eta" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fulfilledAt" TIMESTAMP(3),

    CONSTRAINT "arrival_notices_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "arrival_notices_doctorId_idx" ON "arrival_notices"("doctorId");

CREATE INDEX "arrival_notices_fulfilledAt_idx" ON "arrival_notices"("fulfilledAt");

ALTER TABLE "arrival_notices" ADD CONSTRAINT "arrival_notices_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
