-- Reverse of 20270502004500_planned_meal_and_workout_times, for a confirmed
-- defect only: drops the coach's planned meal and workout times (data loss for
-- those two columns only; their CHECKs go with them). No policy changes.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "ClientWorkoutAssignment"
  DROP COLUMN IF EXISTS "scheduled_time";

ALTER TABLE "DailyMealPlanSlot"
  DROP COLUMN IF EXISTS "time_of_day";

COMMIT;
