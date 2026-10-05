-- S-SCHED-5: booking request auto-expiry (OR-112-5).
--
-- 1. SessionStatus gains 'expired': a request the coach did not answer by its
--    clear time. Terminal. It is NOT in the occupying set, so the
--    CoachingSession_no_overlapping_active_booking exclusion constraint
--    (status IN ('requested','scheduled','pending_provider')) frees the slot
--    the moment a row becomes expired. The new value is not used anywhere in
--    this file (a value added by ALTER TYPE cannot be used in the same
--    transaction).
-- 2. CoachingSession.request_expires_at: the clear time a pending request
--    closes. Set by the service on request and when a client move asks again.
--    Rule (src/scheduling/scheduling.types.ts requestExpiresAt): the earlier
--    of 48 hours after the request and 1 hour before the start; a short-notice
--    request that would get less than 30 minutes stays open until the start.
--    Existing pending requests are backfilled with the same rule measured
--    from this migration (now()), so no coach loses answer time to the deploy
--    and nothing expires at deploy for a future session. A pending request
--    whose start has already passed gets request_expires_at = start_at and is
--    closed by the first sweep (quietly when its time is more than 24 hours
--    old; see BookingRequestExpiryJob).
-- 3. Index (status, request_expires_at) for the expiry sweep.
-- 4. SchedulingJobLease: single-runner lease row per scheduling sweep (same
--    shape and rule as the S-FEE CronLease of backend #627). RLS enabled and
--    forced; only service_role and the platform owner may touch it.
--
-- Reverse with down.sql (the enum value stays; see there).

-- 1. ------------------------------------------------------------------------
ALTER TYPE "SessionStatus" ADD VALUE IF NOT EXISTS 'expired';

-- 2. ------------------------------------------------------------------------
ALTER TABLE "CoachingSession" ADD COLUMN IF NOT EXISTS "request_expires_at" TIMESTAMP(3);

UPDATE "CoachingSession"
SET "request_expires_at" = CASE
  WHEN "start_at" <= now() THEN "start_at"
  WHEN LEAST(now() + interval '48 hours', "start_at" - interval '1 hour') < now() + interval '30 minutes'
    THEN "start_at"
  ELSE LEAST(now() + interval '48 hours', "start_at" - interval '1 hour')
END
WHERE "status" = 'requested' AND "request_expires_at" IS NULL;

-- 3. ------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "CoachingSession_status_request_expires_at_idx"
  ON "CoachingSession" ("status", "request_expires_at");

-- 4. ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "SchedulingJobLease" (
    "name" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "lease_until" TIMESTAMP(3) NOT NULL,
    "acquired_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SchedulingJobLease_pkey" PRIMARY KEY ("name")
);

ALTER TABLE "SchedulingJobLease" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SchedulingJobLease" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "scheduling_job_lease_service_role_all" ON "SchedulingJobLease";
CREATE POLICY "scheduling_job_lease_service_role_all" ON "SchedulingJobLease"
  AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "scheduling_job_lease_owner_all" ON "SchedulingJobLease";
CREATE POLICY "scheduling_job_lease_owner_all" ON "SchedulingJobLease"
  FOR ALL TO public USING (app.is_owner()) WITH CHECK (app.is_owner());
