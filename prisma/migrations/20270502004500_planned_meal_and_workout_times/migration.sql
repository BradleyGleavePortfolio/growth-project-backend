-- C2-C0 (MOCKUP-3 C2, Style C): the times on the client's day. Two nullable
-- columns and their format checks; no policy change, no data change, no
-- backfill, so every existing plan and assignment reads null (no time).
--   * DailyMealPlanSlot.time_of_day: the coach's planned time for the meal.
--   * ClientWorkoutAssignment.scheduled_time: the coach's planned training
--     time that day (scheduled_for keeps the date).
-- Both are a local clock time, "HH:MM" on the 24-hour clock; the CHECKs hold
-- the API's rule (src/common/validators/time-of-day.ts).
-- Row rules: RLS is enabled and forced on both tables, and the columns follow
-- the policies of the rows they sit on (20270419000000, 20270502000700,
-- 20270502000800, 20270502000900): the plan's coach reads and writes a slot
-- while every client holding the plan is still theirs, a client reads the
-- slots of a plan they hold; the client reads their own assignment, the
-- current coach reads every assignment of their client, a former coach reads
-- none, and no API role writes an assignment (the backend writes through
-- service_role).
-- Live proof: test/rls/planned-times-rls.spec.ts (rls-live-tests).
-- Reverse: down.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "DailyMealPlanSlot"
  ADD COLUMN "time_of_day" TEXT,
  ADD CONSTRAINT "DailyMealPlanSlot_time_of_day_check"
    CHECK ("time_of_day" IS NULL OR "time_of_day" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

ALTER TABLE "ClientWorkoutAssignment"
  ADD COLUMN "scheduled_time" TEXT,
  ADD CONSTRAINT "ClientWorkoutAssignment_scheduled_time_check"
    CHECK ("scheduled_time" IS NULL OR "scheduled_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

COMMIT;
