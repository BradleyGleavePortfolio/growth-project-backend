-- Down for 20270502010700_routine_exercise_catalog_id (EXID-BE). Drops the library exercise id on routine
-- exercises, its foreign key and its index.
-- Irreversible for data: every stored id is deleted; routines and their exercises otherwise stay. After the
-- down, Watch video falls back to what it did before (no library video from a routine).

SET lock_timeout = '5s';

ALTER TABLE "RoutineExercise" DROP CONSTRAINT IF EXISTS "RoutineExercise_catalog_exercise_id_fkey";

DROP INDEX IF EXISTS "RoutineExercise_catalog_exercise_id_idx";

ALTER TABLE "RoutineExercise" DROP COLUMN IF EXISTS "catalog_exercise_id";

RESET lock_timeout;
