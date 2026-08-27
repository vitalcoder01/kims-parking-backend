-- Client crash diagnostics.
--
-- One row per DISTINCT fault, not per occurrence: a render loop can fire the
-- same error hundreds of times a minute, and the question worth answering is
-- never "how many events" but "is this still happening, to how many people,
-- since which version". The unique fingerprint plus a counter is what keeps
-- this table readable and keeps a crash loop from becoming a storage problem.
--
-- Purely additive — creates one new table and its indexes. Nothing existing
-- is altered or dropped.
--
-- Written by hand rather than generated. `prisma migrate dev` cannot run in
-- this project: the shadow-database replay fails on the pre-existing
-- 20260729080000_drop_visitor_purpose migration, whose bare
-- `ALTER TABLE "visitors" DROP COLUMN "purpose"` has no IF EXISTS guard and
-- so cannot be applied to a fresh database. `migrate deploy` does not use a
-- shadow database and applies this fine.
CREATE TABLE IF NOT EXISTS "client_errors" (
    "id"          SERIAL       NOT NULL,
    "fingerprint" TEXT         NOT NULL,
    "platform"    TEXT         NOT NULL,
    "appVersion"  TEXT         NOT NULL,
    "name"        TEXT         NOT NULL,
    "message"     TEXT         NOT NULL,
    "stack"       TEXT,
    "screen"      TEXT,
    "roles"       TEXT[]       DEFAULT ARRAY[]::TEXT[],
    "userCount"   INTEGER      NOT NULL DEFAULT 1,
    "count"       INTEGER      NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt"  TIMESTAMP(3),

    CONSTRAINT "client_errors_pkey" PRIMARY KEY ("id")
);

-- The fingerprint is the aggregation key; intake upserts against it.
CREATE UNIQUE INDEX IF NOT EXISTS "client_errors_fingerprint_key" ON "client_errors"("fingerprint");

-- Triage reads newest-first, filtered to unresolved.
CREATE INDEX IF NOT EXISTS "client_errors_lastSeenAt_idx" ON "client_errors"("lastSeenAt");
CREATE INDEX IF NOT EXISTS "client_errors_resolvedAt_idx" ON "client_errors"("resolvedAt");
