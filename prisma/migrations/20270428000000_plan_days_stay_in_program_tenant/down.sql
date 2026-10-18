-- Down for 20270428000000_plan_days_stay_in_program_tenant (PLANPROG).
-- Drops the two restrictive policies, then their helper. This brings back the
-- gap: a plan could again be inserted into, or moved into, another coach's
-- program, or point at another plan's revision. No data to restore.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP POLICY IF EXISTS "WorkoutPlan_links_in_tenant_insert" ON "WorkoutPlan";
DROP POLICY IF EXISTS "WorkoutPlan_links_in_tenant_update" ON "WorkoutPlan";
DROP FUNCTION IF EXISTS app.workout_plan_links_in_tenant(text, text, text, text);

COMMIT;
