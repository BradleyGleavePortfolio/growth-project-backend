-- P1-1: Add a lease timestamp to CoachBrief so a crashed/timed-out worker
-- cannot leave a row stuck in status='generating' forever. The
-- CoachBriefService claim path uses this column to atomically steal a
-- stale lease (status='generating' AND generation_started_at older than
-- the TTL) and re-issue generation for the new caller.
--
-- The column is server-only — RLS on CoachBrief does NOT expose any
-- write policy to coaches (the existing migration only grants SELECT to
-- the coach role), so a malicious client cannot poison the lease.

ALTER TABLE "CoachBrief"
  ADD COLUMN IF NOT EXISTS "generation_started_at" TIMESTAMP(3);

-- Partial index — only the 'generating' rows ever need a stale-lease
-- scan, so we keep the index tight to that subset.
CREATE INDEX IF NOT EXISTS "CoachBrief_generating_lease_idx"
  ON "CoachBrief" ("generation_started_at")
  WHERE "status" = 'generating';

-- ROLLBACK:
-- DROP INDEX IF EXISTS "CoachBrief_generating_lease_idx";
-- ALTER TABLE "CoachBrief" DROP COLUMN IF EXISTS "generation_started_at";
