-- RLSLIVE1b (agent 145, RLSINV I04): the workout plan and assignment row
-- rules use the same user id as every other rule. Seven policies and
-- app.caller_coaches_client found the caller with
--   (SELECT "User".id FROM "User" WHERE "User".supabase_id = auth.uid()::text)
-- while every other policy reads app.current_user_id(), the User.id the
-- backend sets in the app.current_user_id GUC. Under that model (GUC only, no
-- JWT) the seven denied every workout read and write to coach and client
-- alike; under a Data API JWT they keyed on a different id than every other
-- rule, so widening "User" with a JWT branch would have opened them.
--
-- NOW: each rule reads app.current_user_id() behind an IS NOT NULL guard, and
-- assignment_coach_manage checks the role with app.current_user_role(). Every
-- other condition is kept as it is: the program rule in WorkoutPlan_coach_owner
-- (app.workout_program_stays_in_tenant), the plan-ownership check and
-- app.caller_coaches_client in assignment_coach_manage. The RESTRICTIVE
-- WorkoutPlan_links_in_tenant_insert / _update (#992) are not touched.
-- app.caller_coaches_client resolves the caller by User.id = app.current_user_id(), and
-- its rule is unchanged. EXECUTE goes to authenticated and service_role only.
--
-- A Data API caller (JWT, no GUC) has app.current_user_id() = NULL and is
-- refused by all seven. The backend connects as service_role (BYPASSRLS) and
-- the app reads no table directly, so no app path changes. No data change.
-- Reverse: down.sql restores the previous text, comments and grants exactly.
-- Live proof: test/rls/workout-identity-rls.spec.ts (rls-live-tests).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

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
       WHERE caller."id" = app.current_user_id()
         AND client."deleted_at" IS NULL
         AND (
           -- (a) head coach / owner: the client is on the caller's own roster
           client."coach_id" = caller."id"
           OR (
             -- (b) sub-coach with explicit team membership and an OPEN assignment to this student,
             -- from the head coach who still has the client
             caller."role" = 'coach'
             AND caller."coach_id" IS NOT NULL
             AND client."role" = 'student'
             AND client."coach_id" = caller."coach_id"
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
                 AND sca."head_coach_id" = caller."coach_id"
                 AND sca."unassigned_at" IS NULL
             )
           )
         )
     )
$$;
COMMENT ON FUNCTION app.caller_coaches_client(text) IS
  'Caller-bound RLS helper (D8, 20270319000000; 20270414000000; 20270502000800): true when the CALLER (User.id = app.current_user_id()) may act on the supplied client User.id under the application rule WorkoutBuilderService.assertCanAccessClient / SubCoachScopeService.canAccessClient: the client is not soft-deleted and either its coach_id is the caller, or the caller is a sub-coach (role coach, coach_id set, explicit team membership) with an open SubCoachAssignment from their head coach to a student who is still that head coach''s. Only argument is the client id. Called by assignment_coach_manage USING and WITH CHECK.';
REVOKE ALL ON FUNCTION app.caller_coaches_client(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.caller_coaches_client(text) FROM anon;
GRANT EXECUTE ON FUNCTION app.caller_coaches_client(text) TO authenticated, service_role;

ALTER POLICY "WorkoutPlan_coach_owner" ON "WorkoutPlan"
  USING (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id() AND app.workout_program_stays_in_tenant("program_id"))
  WITH CHECK (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id() AND app.workout_program_stays_in_tenant("program_id"));
COMMENT ON POLICY "WorkoutPlan_coach_owner" ON "WorkoutPlan" IS '20270502000800: the plan''s coach (app.current_user_id()), while its program stays in their tenant (no program, a master, or a copy whose clients have not left).';

ALTER POLICY "client_read_assigned_plans" ON "WorkoutPlan"
  USING (app.current_user_id() IS NOT NULL AND "id" IN (SELECT "workout_plan_id" FROM "ClientWorkoutAssignment" WHERE "client_id" = app.current_user_id()));
COMMENT ON POLICY "client_read_assigned_plans" ON "WorkoutPlan" IS '20270502000800: a client (app.current_user_id()) reads the plans assigned to them. Read only.';

ALTER POLICY "WorkoutPlanExercise_through_plan" ON "WorkoutPlanExercise"
  USING (app.current_user_id() IS NOT NULL AND EXISTS (SELECT 1 FROM "WorkoutPlan" wp WHERE wp."id" = "WorkoutPlanExercise"."workout_plan_id" AND wp."coach_id" = app.current_user_id()))
  WITH CHECK (app.current_user_id() IS NOT NULL AND EXISTS (SELECT 1 FROM "WorkoutPlan" wp WHERE wp."id" = "WorkoutPlanExercise"."workout_plan_id" AND wp."coach_id" = app.current_user_id()));
COMMENT ON POLICY "WorkoutPlanExercise_through_plan" ON "WorkoutPlanExercise" IS '20270502000800: the coach (app.current_user_id()) of the owning plan, through that plan''s own row rules.';

ALTER POLICY "client_read_assigned_exercises" ON "WorkoutPlanExercise"
  USING (app.current_user_id() IS NOT NULL AND "workout_plan_id" IN (SELECT "workout_plan_id" FROM "ClientWorkoutAssignment" WHERE "client_id" = app.current_user_id()));
COMMENT ON POLICY "client_read_assigned_exercises" ON "WorkoutPlanExercise" IS '20270502000800: a client (app.current_user_id()) reads the exercises of plans assigned to them. Read only.';

ALTER POLICY "assignment_client_read" ON "ClientWorkoutAssignment"
  USING (app.current_user_id() IS NOT NULL AND "client_id" = app.current_user_id());
COMMENT ON POLICY "assignment_client_read" ON "ClientWorkoutAssignment" IS '20270502000800: a client (app.current_user_id()) reads their own assignments. Read only.';

ALTER POLICY "assignment_coach_manage" ON "ClientWorkoutAssignment"
  USING (
    app.current_user_id() IS NOT NULL
    AND "assigned_by_coach_id" = app.current_user_id()
    AND app.current_user_role() IN ('coach', 'owner', 'sub_coach')
    AND app.caller_coaches_client("client_id")
  )
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND "assigned_by_coach_id" = app.current_user_id()
    AND app.current_user_role() IN ('coach', 'owner', 'sub_coach')
    AND EXISTS (SELECT 1 FROM "WorkoutPlan" wp WHERE wp."id" = "ClientWorkoutAssignment"."workout_plan_id" AND wp."coach_id" = app.current_user_id())
    AND app.caller_coaches_client("client_id")
  );
COMMENT ON POLICY "assignment_coach_manage" ON "ClientWorkoutAssignment" IS
  '20270502000800: the assigning coach (app.current_user_id(), role coach / owner / sub_coach by app.current_user_role()) manages assignments only for clients the caller may act on (app.caller_coaches_client(client_id)) and, on write, only for their own plan.';

ALTER POLICY "WorkoutBuilderIdempotencyKey_owner" ON "WorkoutBuilderIdempotencyKey"
  USING (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())
  WITH CHECK (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id());
COMMENT ON POLICY "WorkoutBuilderIdempotencyKey_owner" ON "WorkoutBuilderIdempotencyKey" IS '20270502000800: only the owning user (app.current_user_id()) reads or writes their own idempotency rows.';

COMMIT;
