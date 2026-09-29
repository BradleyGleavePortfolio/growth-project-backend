-- Rollback of 20270125000012 (D8): drop the three D8 functions (app.rls_actor_id,
-- app.actor_owns_workout_plan, app.actor_coaches_client), recreate app.current_user_owns_workout_plan(text)
-- with its 20270125000011 body, comment and ACL verbatim (auth.uid()-keyed), and restore the
-- 20270125000011 text of "assignment_coach_manage" verbatim (auth.uid()-keyed, role gate incl.
-- sub_coach, no client-tenancy predicate). Run FIRST in the S8-D3 down chain (before 20270125000011).
-- Metadata only.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP POLICY IF EXISTS "assignment_coach_manage" ON public."ClientWorkoutAssignment";

DROP FUNCTION IF EXISTS app.actor_coaches_client(text, text);
DROP FUNCTION IF EXISTS app.actor_owns_workout_plan(text, text);
DROP FUNCTION IF EXISTS app.rls_actor_id();

CREATE OR REPLACE FUNCTION app.current_user_owns_workout_plan(plan_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT plan_id IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public."WorkoutPlan" wp
       WHERE wp."id" = plan_id
         AND wp."coach_id" = (
           SELECT u."id" FROM public."User" u WHERE u."supabase_id" = auth.uid()::text
         )
     )
$$;

COMMENT ON FUNCTION app.current_user_owns_workout_plan(text) IS
  'Security-definer RLS helper: true when the WorkoutPlan with this id is owned (coach_id) by the User whose supabase_id is auth.uid(). Exists to break the WorkoutPlan <-> ClientWorkoutAssignment policy cycle; the predicate is the one assignment_coach_manage WITH CHECK spelled inline.';

REVOKE ALL ON FUNCTION app.current_user_owns_workout_plan(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_user_owns_workout_plan(text) TO service_role, anon, authenticated;

CREATE POLICY "assignment_coach_manage"
    ON public."ClientWorkoutAssignment"
    AS PERMISSIVE
    FOR ALL
    TO PUBLIC
    USING (
        "person_id" IS NULL
        AND "assigned_by_coach_id" = (
            SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text
        )
        AND EXISTS (
            SELECT 1
            FROM "User" u
            WHERE u."supabase_id" = auth.uid()::text
              AND u."role" IN ('coach', 'owner', 'sub_coach')
        )
    )
    WITH CHECK (
        "person_id" IS NULL
        AND "assigned_by_coach_id" = (
            SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text
        )
        AND EXISTS (
            SELECT 1
            FROM "User" u
            WHERE u."supabase_id" = auth.uid()::text
              AND u."role" IN ('coach', 'owner', 'sub_coach')
        )
        AND app.current_user_owns_workout_plan("workout_plan_id")
    );

COMMIT;
