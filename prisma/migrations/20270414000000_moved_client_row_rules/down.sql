-- Reverse of 20270414000000_moved_client_row_rules. Only for a confirmed
-- defect: a former coach reads and writes a moved client's program copy, its
-- days, meal-plan assignments and stored briefs again through direct table
-- access, and a sub-coach's open delegation outlives a move. Restores the
-- 20260508000001, 20261215000000, 20261213000000, 20260525120000 and
-- 20270319000000 text verbatim.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER POLICY "WorkoutPlan_coach_owner" ON "WorkoutPlan"
  USING ("coach_id" = (SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text))
  WITH CHECK ("coach_id" = (SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text));
COMMENT ON POLICY "WorkoutPlan_coach_owner" ON "WorkoutPlan" IS NULL;

ALTER POLICY "p_workoutprogram_select" ON "WorkoutProgram"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "owner_user_id" = app.current_user_id()) OR (app.current_user_id() IS NOT NULL AND "visibility" = 'tenant_shared' AND (app.is_current_coach_of("coach_id") OR app.is_subcoach_of("coach_id") OR EXISTS (SELECT 1 FROM public."User" u WHERE u."id" = app.current_user_id() AND (u."id" = "WorkoutProgram"."coach_id" OR u."coach_id" = "WorkoutProgram"."coach_id"))))));
COMMENT ON POLICY "p_workoutprogram_select" ON "WorkoutProgram" IS 'Owner-self read with tenant-shared overlay: owner admin, the row owner (owner_user_id), or — for tenant_shared rows — a head coach / sub-coach in the same coach_id tenant may SELECT.';
ALTER POLICY "p_workoutprogram_insert" ON "WorkoutProgram"
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "owner_user_id" = app.current_user_id())));
COMMENT ON POLICY "p_workoutprogram_insert" ON "WorkoutProgram" IS 'Owner-self write: only owner admin or the row''s own owner_user_id may INSERT. Forking writes a new owner-stamped row so the fork passes.';
ALTER POLICY "p_workoutprogram_update" ON "WorkoutProgram"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "owner_user_id" = app.current_user_id())))
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "owner_user_id" = app.current_user_id())));
COMMENT ON POLICY "p_workoutprogram_update" ON "WorkoutProgram" IS 'Owner-self update: owner admin or the row owner may UPDATE; CHECK prevents re-owning the row to another owner_user_id.';
ALTER POLICY "p_workoutprogram_delete" ON "WorkoutProgram"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "owner_user_id" = app.current_user_id())));
COMMENT ON POLICY "p_workoutprogram_delete" ON "WorkoutProgram" IS 'Owner-self delete: owner admin or the row owner may DELETE.';

ALTER POLICY "p_dailymealplanassignment_select" ON "DailyMealPlanAssignment"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR "assigned_by_coach_id" = app.current_user_id()))));
COMMENT ON POLICY "p_dailymealplanassignment_select" ON "DailyMealPlanAssignment" IS 'PR-RLS-05 client-self-or-assigned-coach: only the owner, the assigned client (client_id), or the assigning coach (assigned_by_coach_id) may read. Transitive app.is_current_coach_of(client_id) is intentionally EXCLUDED so a later/different current coach cannot see assignments they did not make.';
ALTER POLICY "p_dailymealplanassignment_insert" ON "DailyMealPlanAssignment"
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR "assigned_by_coach_id" = app.current_user_id()))));
COMMENT ON POLICY "p_dailymealplanassignment_insert" ON "DailyMealPlanAssignment" IS 'PR-RLS-05 client-self-or-assigned-coach: only the owner, the assigned client, or the assigning coach may insert. Transitive current-coach access is intentionally excluded.';
ALTER POLICY "p_dailymealplanassignment_update" ON "DailyMealPlanAssignment"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR "assigned_by_coach_id" = app.current_user_id()))))
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR "assigned_by_coach_id" = app.current_user_id()))));
COMMENT ON POLICY "p_dailymealplanassignment_update" ON "DailyMealPlanAssignment" IS 'PR-RLS-05 client-self-or-assigned-coach: only the owner, assigned client, or assigning coach may update; post-image must satisfy the same predicate. Transitive current-coach access is intentionally excluded.';
ALTER POLICY "p_dailymealplanassignment_delete" ON "DailyMealPlanAssignment"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR "assigned_by_coach_id" = app.current_user_id()))));
COMMENT ON POLICY "p_dailymealplanassignment_delete" ON "DailyMealPlanAssignment" IS 'PR-RLS-05 client-self-or-assigned-coach: only the owner, assigned client, or assigning coach may delete. Transitive current-coach access is intentionally excluded.';

ALTER POLICY "coach_select_own_brief" ON "CoachBrief"
  USING (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id());
COMMENT ON POLICY "coach_select_own_brief" ON "CoachBrief" IS NULL;

CREATE OR REPLACE FUNCTION app.caller_coaches_client(client_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT client_user_id IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public."User" caller
       JOIN public."User" client ON client."id" = client_user_id
       WHERE caller."supabase_id" = auth.uid()::text
         AND client."deleted_at" IS NULL
         AND (
           -- (a) head coach / owner: the client is on the caller's own roster
           client."coach_id" = caller."id"
           OR (
             -- (b) sub-coach with explicit team membership and an OPEN assignment to this student
             caller."role" = 'coach'
             AND caller."coach_id" IS NOT NULL
             AND client."role" = 'student'
             AND (
               EXISTS (
                 SELECT 1
                 FROM public."TeamSubCoachAssignment" seat
                 WHERE seat."head_coach_id" = caller."coach_id"
                   AND seat."sub_coach_id" = caller."id"
                   AND seat."archived_at" IS NULL
               )
               OR EXISTS (
                 SELECT 1
                 FROM public."SubCoachAssignment" delegation
                 WHERE delegation."head_coach_id" = caller."coach_id"
                   AND delegation."sub_coach_id" = caller."id"
                   AND delegation."unassigned_at" IS NULL
               )
             )
             AND EXISTS (
               SELECT 1
               FROM public."SubCoachAssignment" sca
               WHERE sca."sub_coach_id" = caller."id"
                 AND sca."client_id" = client."id"
                 AND sca."unassigned_at" IS NULL
             )
           )
         )
     )
$$;

COMMENT ON FUNCTION app.caller_coaches_client(text) IS
  'Caller-bound RLS helper (D8, 20270319000000): true when the CALLER (User.supabase_id = auth.uid()) may act on the supplied client User.id under the application rule WorkoutBuilderService.assertCanAccessClient / SubCoachScopeService.canAccessClient: the client is not soft-deleted and either its coach_id is the caller, or the caller is a sub-coach (role coach, coach_id set, explicit team membership) with an open SubCoachAssignment to that student. Only argument is the client id. Called by assignment_coach_manage USING and WITH CHECK.';

DROP FUNCTION app.caller_still_coaches_brief_clients(text, jsonb);
DROP FUNCTION app.workout_program_stays_in_tenant(text);
DROP FUNCTION app.client_in_coach_tenant(text, text);

COMMIT;
