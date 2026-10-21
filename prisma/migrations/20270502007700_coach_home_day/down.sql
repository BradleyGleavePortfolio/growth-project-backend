-- Reverse of 20270502007700_coach_home_day.
DROP INDEX IF EXISTS "ExerciseSet_workout_id_idx";
ALTER TABLE "CoachMessage" DROP COLUMN IF EXISTS "automated_by";
