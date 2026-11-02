-- 20270502010700_routine_exercise_catalog_id (EXID-BE, agent 190; owner #189-D4 op 1): each routine exercise
-- keeps the library exercise it came from, so Watch video on the phone opens that exercise's video.
--
-- RoutineExercise.catalog_exercise_id: the ExerciseCatalogItem id the client picked. NULL = an exercise of the
-- client's own, or a row saved before this column. Additive only: one nullable column, no default, no
-- backfill and no data rewrite; every existing row keeps NULL, so the foreign key validates over existing
-- data without a conflict. ON DELETE SET NULL: a library item removed later leaves NULL and the routine
-- stays whole. The server stores only ids of library rows that exist (WorkoutService).
-- No RLS change: RoutineExercise keeps its child-via-routine policies (20261213000000), which cover every
-- column; ExerciseCatalogItem is unchanged.
-- Reverse: down.sql.

SET lock_timeout = '5s';

ALTER TABLE "RoutineExercise" ADD COLUMN IF NOT EXISTS "catalog_exercise_id" TEXT;

CREATE INDEX IF NOT EXISTS "RoutineExercise_catalog_exercise_id_idx" ON "RoutineExercise"("catalog_exercise_id");

ALTER TABLE "RoutineExercise" ADD CONSTRAINT "RoutineExercise_catalog_exercise_id_fkey" FOREIGN KEY ("catalog_exercise_id") REFERENCES "ExerciseCatalogItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

RESET lock_timeout;
