-- Closes a real race in visitor.service.js createVisitor: the "is this a
-- duplicate check-in" guard was a plain check-then-insert with no atomicity
-- behind it, so two near-simultaneous requests (e.g. two valet devices
-- checking in the same walk-in within the same moment) could both pass the
-- "no duplicate found" query before either INSERT committed, producing two
-- real Visitor rows with the same car/mobile. A partial unique index makes
-- "one pending visitor per car+mobile" an actual database guarantee — the
-- second insert now fails outright instead of silently succeeding twice,
-- and the app catches that failure and returns the winner's row instead.
CREATE UNIQUE INDEX IF NOT EXISTS "visitors_pending_car_mobile_unique"
ON "visitors" ("carNumber", "mobile")
WHERE "status" = 'pending';
