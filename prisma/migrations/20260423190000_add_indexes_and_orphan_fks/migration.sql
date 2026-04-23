-- Round-2 stability migration
-- Adds: composite indexes on hot-path logging tables, and proper FKs for
-- previously-orphan columns (User.coach_id, WorkoutRoutine.creator_id, Lesson.coach_id).
-- All CREATE INDEX ... IF NOT EXISTS so it's safe to run on an environment where
-- the baseline has already been resolved-as-applied and the tables are populated.

-- ---- indexes (hot paths) ----
CREATE INDEX IF NOT EXISTS "User_coach_id_idx" ON "User"("coach_id");
CREATE INDEX IF NOT EXISTS "LoggedFoodEntry_user_id_date_idx" ON "LoggedFoodEntry"("user_id", "date");
CREATE INDEX IF NOT EXISTS "WorkoutSession_user_id_date_idx" ON "WorkoutSession"("user_id", "date");
CREATE INDEX IF NOT EXISTS "WorkoutRoutine_creator_id_idx" ON "WorkoutRoutine"("creator_id");
CREATE INDEX IF NOT EXISTS "WeightLog_user_id_date_idx" ON "WeightLog"("user_id", "date");
CREATE INDEX IF NOT EXISTS "HabitLog_habit_id_date_idx" ON "HabitLog"("habit_id", "date");
CREATE INDEX IF NOT EXISTS "Lesson_coach_id_idx" ON "Lesson"("coach_id");
CREATE INDEX IF NOT EXISTS "CheckIn_user_id_date_idx" ON "CheckIn"("user_id", "date");
CREATE INDEX IF NOT EXISTS "water_logs_user_id_logged_at_idx" ON "water_logs"("user_id", "logged_at");

-- ---- FKs for previously orphan columns ----
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'User_coach_id_fkey'
  ) THEN
    ALTER TABLE "User"
      ADD CONSTRAINT "User_coach_id_fkey"
      FOREIGN KEY ("coach_id") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WorkoutRoutine_creator_id_fkey'
  ) THEN
    ALTER TABLE "WorkoutRoutine"
      ADD CONSTRAINT "WorkoutRoutine_creator_id_fkey"
      FOREIGN KEY ("creator_id") REFERENCES "User"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Lesson_coach_id_fkey'
  ) THEN
    ALTER TABLE "Lesson"
      ADD CONSTRAINT "Lesson_coach_id_fkey"
      FOREIGN KEY ("coach_id") REFERENCES "User"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
