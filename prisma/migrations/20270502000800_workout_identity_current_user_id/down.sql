-- Down for 20270502000800_workout_identity_current_user_id (RLSLIVE1b).
-- Restores the seven policies and app.caller_coaches_client exactly as the
-- chain left them (20260508000001, 20260508000003, 20260620000000,
-- 20260621000000, 20270319000000, 20270414000000): the caller is found again
-- through auth.uid() and a sub-select on "User", the comments are restored
-- (NULL where there was none) and anon gets EXECUTE on the helper back. This
-- brings back I04: under the backend model (GUC only) every workout read and
-- write is refused again. The program rule and the #992 restrictive policies
-- are not touched. No data to restore.
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
       WHERE caller."supabase_id" = auth.uid()::text
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
  'Caller-bound RLS helper (D8, 20270319000000; 20270414000000): true when the CALLER (User.supabase_id = auth.uid()) may act on the supplied client User.id under the application rule WorkoutBuilderService.assertCanAccessClient / SubCoachScopeService.canAccessClient: the client is not soft-deleted and either its coach_id is the caller, or the caller is a sub-coach (role coach, coach_id set, explicit team membership) with an open SubCoachAssignment from their head coach to a student who is still that head coach''s. Only argument is the client id. Called by assignment_coach_manage USING and WITH CHECK.';
REVOKE ALL ON FUNCTION app.caller_coaches_client(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.caller_coaches_client(text) TO anon, authenticated, service_role;

ALTER POLICY "WorkoutPlan_coach_owner" ON "WorkoutPlan"
  USING ("coach_id" = (SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text) AND app.workout_program_stays_in_tenant("program_id"))
  WITH CHECK ("coach_id" = (SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text) AND app.workout_program_stays_in_tenant("program_id"));
COMMENT ON POLICY "WorkoutPlan_coach_owner" ON "WorkoutPlan" IS '20270414000000: the plan''s coach, while its program stays in their tenant (no program, a master, or a copy whose clients have not left).';

ALTER POLICY "client_read_assigned_plans" ON "WorkoutPlan"
  USING ("id" IN (SELECT "workout_plan_id" FROM "ClientWorkoutAssignment" WHERE "client_id" = (SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text)));
COMMENT ON POLICY "client_read_assigned_plans" ON "WorkoutPlan" IS NULL;

ALTER POLICY "WorkoutPlanExercise_through_plan" ON "WorkoutPlanExercise"
  USING (EXISTS (SELECT 1 FROM "WorkoutPlan" wp JOIN "User" u ON u."id" = wp."coach_id" WHERE wp."id" = "WorkoutPlanExercise"."workout_plan_id" AND u."supabase_id" = auth.uid()::text))
  WITH CHECK (EXISTS (SELECT 1 FROM "WorkoutPlan" wp JOIN "User" u ON u."id" = wp."coach_id" WHERE wp."id" = "WorkoutPlanExercise"."workout_plan_id" AND u."supabase_id" = auth.uid()::text));
COMMENT ON POLICY "WorkoutPlanExercise_through_plan" ON "WorkoutPlanExercise" IS NULL;

ALTER POLICY "client_read_assigned_exercises" ON "WorkoutPlanExercise"
  USING ("workout_plan_id" IN (SELECT "workout_plan_id" FROM "ClientWorkoutAssignment" WHERE "client_id" = (SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text)));
COMMENT ON POLICY "client_read_assigned_exercises" ON "WorkoutPlanExercise" IS NULL;

ALTER POLICY "assignment_client_read" ON "ClientWorkoutAssignment"
  USING ("client_id" = (SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text));
COMMENT ON POLICY "assignment_client_read" ON "ClientWorkoutAssignment" IS NULL;

ALTER POLICY "assignment_coach_manage" ON "ClientWorkoutAssignment"
  USING (
    "assigned_by_coach_id" = (SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text)
    AND EXISTS (SELECT 1 FROM "User" u WHERE u."supabase_id" = auth.uid()::text AND u."role" IN ('coach', 'owner', 'sub_coach'))
    AND app.caller_coaches_client("client_id")
  )
  WITH CHECK (
    "assigned_by_coach_id" = (SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text)
    AND EXISTS (SELECT 1 FROM "User" u WHERE u."supabase_id" = auth.uid()::text AND u."role" IN ('coach', 'owner', 'sub_coach'))
    AND EXISTS (SELECT 1 FROM "WorkoutPlan" wp WHERE wp."id" = "workout_plan_id" AND wp."coach_id" = (SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text))
    AND app.caller_coaches_client("client_id")
  );
COMMENT ON POLICY "assignment_coach_manage" ON "ClientWorkoutAssignment" IS
  'Assigning coach manages assignments (20260702000000 conditions verbatim) only for clients the caller may act on: app.caller_coaches_client(client_id) in USING and WITH CHECK (D8, 20270319000000).';

ALTER POLICY "WorkoutBuilderIdempotencyKey_owner" ON "WorkoutBuilderIdempotencyKey"
  USING ("user_id" = (SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text))
  WITH CHECK ("user_id" = (SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text));
COMMENT ON POLICY "WorkoutBuilderIdempotencyKey_owner" ON "WorkoutBuilderIdempotencyKey" IS NULL;

COMMIT;
