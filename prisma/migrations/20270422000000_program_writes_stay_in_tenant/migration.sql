-- PROGINSERT (agent 143): a program is written only into a tenant the writer
-- belongs to. p_workoutprogram_insert and p_workoutprogram_update
-- (20261215000000_mwb_1_data_model) check only owner_user_id, never coach_id,
-- so any signed-in user could insert an owner_only program into another
-- coach's tenant, or move one of their own rows there, and then keep editing
-- it as its owner.
--
-- Two RESTRICTIVE policies AND with whatever p_workoutprogram_insert/update
-- say (main's, or #976's after it ALTERs them) and with #980's
-- p_workoutprogram_shared_needs_team, in any merge order. A new or changed
-- row passes only for an owner admin, a row in the writer's own tenant
-- (coach_id = the writer), or a member of the tenant coach's team
-- (app.is_subcoach_on_coach_team, the shared membership helper; #980 makes it
-- judge membership per head coach, and these policies inherit that).
-- UPDATE checks the row both before and after the change.
-- Reads and deletes are unchanged.
--
-- No data changes. service_role and the migration role bypass RLS.
-- Reversible: down.sql drops both policies.
-- Live proof: test/rls/program-writes-stay-in-tenant-rls.spec.ts (rls-live-tests).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP POLICY IF EXISTS "p_workoutprogram_insert_in_own_tenant" ON "WorkoutProgram";
CREATE POLICY "p_workoutprogram_insert_in_own_tenant" ON "WorkoutProgram" AS RESTRICTIVE FOR INSERT TO public
  WITH CHECK ((app.is_owner() OR "coach_id" = app.current_user_id() OR app.is_subcoach_on_coach_team("coach_id")));
COMMENT ON POLICY "p_workoutprogram_insert_in_own_tenant" ON "WorkoutProgram" IS
  'PROGINSERT: restrictive. A program is inserted only by an owner admin, into the writer''s own tenant (coach_id = the writer), or into the tenant of a head coach whose team the writer is on (app.is_subcoach_on_coach_team).';

DROP POLICY IF EXISTS "p_workoutprogram_update_in_own_tenant" ON "WorkoutProgram";
CREATE POLICY "p_workoutprogram_update_in_own_tenant" ON "WorkoutProgram" AS RESTRICTIVE FOR UPDATE TO public
  USING ((app.is_owner() OR "coach_id" = app.current_user_id() OR app.is_subcoach_on_coach_team("coach_id")))
  WITH CHECK ((app.is_owner() OR "coach_id" = app.current_user_id() OR app.is_subcoach_on_coach_team("coach_id")));
COMMENT ON POLICY "p_workoutprogram_update_in_own_tenant" ON "WorkoutProgram" IS
  'PROGINSERT: restrictive. A program is updated only by an owner admin, in the writer''s own tenant, or in the tenant of a head coach whose team the writer is on, before and after the change, so a row cannot be moved into another coach''s tenant.';

COMMIT;
