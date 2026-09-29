-- Rollback of 20270125000012 (D8): restore the 20270125000011 text of "assignment_coach_manage"
-- verbatim (auth.uid()-keyed, no client-tenancy predicate), restore the 20270125000011 body and
-- comment of app.current_user_owns_workout_plan(text) verbatim (auth.uid()-keyed; ACL untouched),
-- and drop the tenancy helper. Run FIRST in the S8-D3 down chain (before 20270125000011).
-- Metadata only.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP POLICY IF EXISTS "assignment_coach_manage" ON public."ClientWorkoutAssignment";

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

DROP FUNCTION IF EXISTS app.current_user_coaches_client(text);

COMMIT;
