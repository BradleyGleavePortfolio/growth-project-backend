-- Add push-dedup columns to CoachBriefPreferences for the daily brief
-- cron. last_push_attempt_date is the atomic pre-send claim (prevents
-- duplicate notifications across Fly.io instances); last_push_date is
-- the confirmed-success marker written only after pushToUser resolves.
ALTER TABLE "CoachBriefPreferences"
  ADD COLUMN IF NOT EXISTS "last_push_attempt_date" TEXT;

ALTER TABLE "CoachBriefPreferences"
  ADD COLUMN IF NOT EXISTS "last_push_date" TEXT;

-- ROLLBACK:
-- ALTER TABLE "CoachBriefPreferences" DROP COLUMN IF EXISTS "last_push_date";
-- ALTER TABLE "CoachBriefPreferences" DROP COLUMN IF EXISTS "last_push_attempt_date";
