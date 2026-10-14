-- Down for 20270422000000_program_writes_stay_in_tenant (PROGINSERT).
-- Drops the two restrictive policies. This brings back the gap: a program
-- could again be inserted into, or moved into, another coach's tenant.
-- No data to restore.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP POLICY IF EXISTS "p_workoutprogram_insert_in_own_tenant" ON "WorkoutProgram";
DROP POLICY IF EXISTS "p_workoutprogram_update_in_own_tenant" ON "WorkoutProgram";

COMMIT;
