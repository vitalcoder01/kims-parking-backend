-- Anchors the retrieval trip countdown. Distinct from requestedAt (when the
-- doctor asked, i.e. their deadline) and from acceptedAt (a driver can accept
-- and then take minutes to walk to the slot).
ALTER TABLE "parking_tasks" ADD COLUMN "startedAt" TIMESTAMP(3);
