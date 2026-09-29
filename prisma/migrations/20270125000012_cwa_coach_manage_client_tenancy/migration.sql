-- ClientWorkoutAssignment: apply the application's coach-client tenancy rule inside
-- `assignment_coach_manage`, keyed on the application's identity context (owner decision D8,
-- 2026-09-29; TIGHTENING ONLY). Stacked on 20270125000011 (PR #587).
--
-- GAP (present since 20260702000000, preserved verbatim by 20270125000000 / 20270125000011):
--   `assignment_coach_manage` checks that the caller is the assigning coach (assigned_by_coach_id),
--   that the caller's role is coach / owner / sub_coach, and (WITH CHECK) that the caller owns the
--   referenced WorkoutPlan. It never checks that the ASSIGNEE ("client_id") is a client the caller
--   may act on. Once 20270125000011 made the write branch live (42P17 fixed), a coach could through
--   direct access insert, re-point, read or delete assignments naming ANY user as the client, as
--   long as the plan was theirs. The application never allowed that: every assignment write goes
--   through WorkoutBuilderService.assertCanAccessClient.
--
-- THE APPLICATION RULE (src/workout-builder/workout-builder.service.ts:842-857 assertCanAccessClient;
-- src/sub-coach/sub-coach-scope.service.ts:22-24, 50-78, 105-108; the AI path
-- src/ai/coach/coach-ai.service.ts:63-70 delegates to the same method). The acting user may act on a
-- client when EITHER
--   (a) the client's User.coach_id is the acting user (head coach / owner direct roster; the app does
--       not test the target's role on this branch), OR
--   (b) the acting user is a sub-coach (User.role = 'coach' AND User.coach_id IS NOT NULL) holding an
--       OPEN SubCoachAssignment (sub_coach_id = acting user, client_id = client, unassigned_at IS
--       NULL) to that client, and the client is a live student (role = 'student', deleted_at IS NULL).
-- This migration encodes exactly that predicate; nothing is widened.
--
-- IDENTITY (one source, the application's): the policy and both helpers are keyed on
-- app.current_user_id() — the User.id the backend sets per request as a transaction-scoped GUC
-- (src/common/interceptors/rls-context.interceptor.ts:50-57, registered globally in
-- src/app.module.ts:429). That is the identity every repo tenancy helper uses
-- (app.is_owner / app.is_current_coach_of, 20261212000000 L70-98; app.is_subcoach_of /
-- app.is_subcoach_on_coach_team, 20261215000000 L171-207), the stated repo convention
-- ("Ownership context is the backend TEXT GUC app.current_user_id() — NOT auth.uid()",
-- 20261213000000 L13-16), and the identity the other S8-D3 tenant policies on this table family use
-- (CheckIn coach policies and the ClientWorkoutAssignmentSnapshot policies, 20270125000000
-- L560-570). The 20260702000000 policy was the outlier: auth.uid() -> User.supabase_id, an identity
-- only a Supabase-JWT PostgREST request would carry; no client of this backend makes such requests
-- against this table (the mobile app uses Supabase for auth and Realtime channels only). Under the
-- application path auth.uid() is NULL and the pre-D8 coach branch was therefore dead; keying it on
-- app.current_user_id() makes the branch mean what the app means, and keying the new tenancy
-- predicate on the same GUC keeps the policy to one identity. The client read policy
-- `assignment_client_read` (auth.uid()-keyed, unchanged since 20260621000000) is out of D8's scope
-- and is left as #587 defines it.
--
-- FIX:
--   1. app.current_user_owns_workout_plan(text) (introduced by 20270125000011) is re-keyed on
--      app.current_user_id(); signature, STABLE / SECURITY DEFINER / search_path = '' hardening,
--      ACL and the predicate shape are unchanged. It still exists to keep "WorkoutPlan" out of the
--      ClientWorkoutAssignment policy graph (42P17).
--   2. NEW app.current_user_coaches_client(text): SECURITY DEFINER (same pattern) because the
--      predicate reads "User" and "SubCoachAssignment" (the policy evaluator may not itself read
--      "SubCoachAssignment" — cf. app.is_subcoach_of) and because a never-inlined function body
--      cannot re-enter the ClientWorkoutAssignment policy graph. It returns only a boolean about the
--      CALLER's own relationship to ONE client id; nobody gains read or write access.
--   3. `assignment_coach_manage` is recreated with the tenancy helper ANDed into BOTH USING and
--      WITH CHECK. Every other condition of the 20270125000011 policy is preserved in meaning:
--      person_id IS NULL, assigned_by_coach_id = caller, caller role IN (coach, owner, sub_coach)
--      read from "User", and app.current_user_owns_workout_plan in WITH CHECK.
--
-- EFFECT (RLS-bound coach path; the application's Prisma connection is service_role-equivalent):
--   * a coach can INSERT / SELECT / UPDATE / DELETE assignments only for clients the app considers
--     theirs; UPDATE cannot re-point client_id to another coach's client (WITH CHECK);
--   * assignments a coach previously created for a client who is not (or no longer) theirs become
--     invisible and immutable to that coach — exactly what assertCanAccessClient would answer. No
--     data is changed, no backfill is needed;
--   * person-owned rows (S8-D3) remain service_role-only: person_id IS NULL is unchanged.
--
-- HARDENING (repo precedent 20270125000011 / 20261212000000 / 20260704000000): STABLE,
-- SECURITY DEFINER, `SET search_path = ''` with every reference schema-qualified, EXECUTE revoked from
-- PUBLIC and granted only to the roles under which the policy is evaluated (service_role,
-- authenticated, anon — anon needs EXECUTE so its refusal stays a POLICY refusal, 42501 on the row).
--
-- LOCKS: CREATE OR REPLACE FUNCTION is catalog-only; DROP/CREATE POLICY takes a short ACCESS
-- EXCLUSIVE on "ClientWorkoutAssignment" (same profile as every prior policy rewrite on this table).
-- Atomic. ROLLBACK: down.sql restores the 20270125000011 policy text and helper body verbatim and
-- drops the tenancy helper.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS app;

-- 1. Plan-ownership helper (20270125000011), re-keyed on the application identity.
CREATE OR REPLACE FUNCTION app.current_user_owns_workout_plan(plan_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT plan_id IS NOT NULL
     AND app.current_user_id() IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public."WorkoutPlan" wp
       WHERE wp."id" = plan_id
         AND wp."coach_id" = app.current_user_id()
     )
$$;

COMMENT ON FUNCTION app.current_user_owns_workout_plan(text) IS
  'Security-definer RLS helper: true when the WorkoutPlan with this id is owned (coach_id) by app.current_user_id(). Exists to break the WorkoutPlan <-> ClientWorkoutAssignment policy cycle; used by assignment_coach_manage WITH CHECK. Re-keyed from auth.uid() to the application GUC by 20270125000012 (D8).';

-- 2. Coach-client tenancy helper (D8): WorkoutBuilderService.assertCanAccessClient at the DB layer.
CREATE OR REPLACE FUNCTION app.current_user_coaches_client(client_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT client_user_id IS NOT NULL
     AND app.current_user_id() IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public."User" caller
       JOIN public."User" client ON client."id" = client_user_id
       WHERE caller."id" = app.current_user_id()
         AND (
           -- (a) head coach / owner: the target is on the caller's own roster
           client."coach_id" = caller."id"
           OR (
             -- (b) sub-coach with an OPEN SubCoachAssignment to a live student
             caller."role" = 'coach'
             AND caller."coach_id" IS NOT NULL
             AND client."role" = 'student'
             AND client."deleted_at" IS NULL
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

COMMENT ON FUNCTION app.current_user_coaches_client(text) IS
  'Security-definer RLS helper (D8): true when app.current_user_id() may act on the supplied client User.id under the application rule WorkoutBuilderService.assertCanAccessClient — the target''s coach_id is the caller, OR the caller is a sub-coach (role coach, coach_id set) with an open SubCoachAssignment to that live student.';

REVOKE ALL ON FUNCTION app.current_user_coaches_client(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_user_coaches_client(text) TO service_role, anon, authenticated;

-- 3. The policy: one identity (app.current_user_id()), tenancy in USING and WITH CHECK.
DROP POLICY IF EXISTS "assignment_coach_manage" ON public."ClientWorkoutAssignment";
CREATE POLICY "assignment_coach_manage"
    ON public."ClientWorkoutAssignment"
    AS PERMISSIVE
    FOR ALL
    TO PUBLIC
    USING (
        "person_id" IS NULL
        AND app.current_user_id() IS NOT NULL
        AND "assigned_by_coach_id" = app.current_user_id()
        AND EXISTS (
            SELECT 1
            FROM "User" u
            WHERE u."id" = app.current_user_id()
              AND u."role" IN ('coach', 'owner', 'sub_coach')
        )
        AND app.current_user_coaches_client("client_id")
    )
    WITH CHECK (
        "person_id" IS NULL
        AND app.current_user_id() IS NOT NULL
        AND "assigned_by_coach_id" = app.current_user_id()
        AND EXISTS (
            SELECT 1
            FROM "User" u
            WHERE u."id" = app.current_user_id()
              AND u."role" IN ('coach', 'owner', 'sub_coach')
        )
        AND app.current_user_coaches_client("client_id")
        AND app.current_user_owns_workout_plan("workout_plan_id")
    );

COMMIT;
