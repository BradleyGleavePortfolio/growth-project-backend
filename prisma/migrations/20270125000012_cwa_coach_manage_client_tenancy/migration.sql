-- ClientWorkoutAssignment: apply the application's coach-client tenancy rule inside
-- `assignment_coach_manage`, on an identity that a JWT principal cannot forge (owner decision D8,
-- 2026-09-29; TIGHTENING ONLY). Stacked on 20270125000011 (PR #587). Fix round 2 of PR #593
-- (closes R593-c7A-01/02, R593-c7B-01/02/03); fix round 3 adds the caller-bound helper layer
-- (closes R593-c7A2-02 / R593-c7B2-03).
--
-- GAP (present since 20260702000000, preserved verbatim by 20270125000000 / 20270125000011):
--   `assignment_coach_manage` checks that the caller is the assigning coach (assigned_by_coach_id),
--   that the caller's role is coach / owner / sub_coach, and (WITH CHECK) that the caller owns the
--   referenced WorkoutPlan. It never checks that the ASSIGNEE ("client_id") is a client the caller
--   may act on. Once 20270125000011 made the write branch live (42P17 fixed), a coach could through
--   direct access insert, re-point, read or delete assignments naming ANY user as the client, as
--   long as the plan was theirs.
--
-- THE APPLICATION RULE (src/workout-builder/workout-builder.service.ts assertCanAccessClient, which
-- the three human assignment writers in WorkoutBuilderService call; src/sub-coach/
-- sub-coach-scope.service.ts canActOnClient / canAccessClient, which the AI approval materialisers
-- AssignWorkoutMaterializer and AssignMealPlanMaterializer call at approval time since PR #593
-- fix round 2 — before that round those two service-role writers applied NO client-tenancy check,
-- which the round-1 text of this header misstated; see the PR body). The acting user may act on a
-- client when EITHER
--   (a) the client's User.coach_id is the acting user (head coach / owner direct roster; the app does
--       not test the target's role on this branch), OR
--   (b) the acting user is a sub-coach (User.role = 'coach' AND User.coach_id IS NOT NULL) holding an
--       OPEN SubCoachAssignment (sub_coach_id = acting user, client_id = client, unassigned_at IS
--       NULL) to that client, and the client is a live student (role = 'student', deleted_at IS NULL).
-- This migration encodes exactly that predicate; nothing is widened. The application's role gate for
-- assignment writes (WorkoutBuilderService.assertCoach) admits coach and owner only, so the policy's
-- role gate is narrowed from ('coach','owner','sub_coach') to ('coach','owner') (R593-c7B-03; no
-- code path assigns Role.sub_coach, so no live principal changes class).
--
-- IDENTITY — WHO IS "THE ACTING USER" (R593-c7A-02): the acting User.id is resolved by
-- app.rls_actor_id() according to the CLASS of SQL principal, and only that class's evidence counts:
--   * anon / authenticated (the two roles Supabase's PostgREST `authenticator` switches to for a
--     JWT-bearing or anonymous API request): the actor is the User whose supabase_id is auth.uid()
--     (the JWT `sub` claim). The backend GUC app.current_user_id is IGNORED for these roles: any
--     PostgREST/SQL session can run set_config('app.current_user_id', ...) — the GUC is not an
--     authenticated fact for them, so it cannot be the identity that unlocks this policy.
--   * every other non-BYPASSRLS role (a role that connects with database credentials the backend
--     holds — there is no JWT for such a session, so auth.uid() is NULL): the actor is
--     app.current_user_id(), the transaction-scoped GUC the backend is designed to set per request.
--     That is the identity every other repo tenancy helper reads (app.is_owner /
--     app.is_current_coach_of, 20261212000000; app.is_subcoach_of, 20261215000000).
--   * service_role / the Prisma connection: BYPASSRLS — the policy is never evaluated; the
--     application (SubCoachScopeService.canActOnClient) is the gate there.
-- The 20260702000000 / 20270125000011 policy was auth.uid()-keyed for every principal, so the GUC
-- branch is NEW for the backend role class only, and the JWT class keeps exactly its prior identity
-- semantics plus the new tenancy predicate.
--
-- WHICH PRINCIPAL IS "INVOKING" (R593-c7A2-02): the class is read by app.rls_principal() from the
-- `role` GUC (what SET ROLE sets — PostgREST's `authenticator` does `SET LOCAL ROLE anon|authenticated`
-- per request) falling back to SESSION_USER (a role that logged in directly, e.g. a backend-class role).
-- That reading is the same inside a SECURITY DEFINER body as outside it: the definer switch changes
-- CURRENT_USER, not the `role` GUC or SESSION_USER. It cannot be forged by the API roles: setting the
-- `role` GUC IS SET ROLE and requires membership, which anon/authenticated do not have.
-- app.rls_actor_id() is SECURITY INVOKER (nothing in it needs definer rights) and builds on it.
--
-- TWO HELPER LAYERS (R593-c7A2-02 / R593-c7B2-03 — no relationship oracle for the API roles):
--   * WORKERS app.actor_coaches_client(actor, client) / app.actor_owns_workout_plan(actor, plan):
--     SECURITY DEFINER (they read "User" / "SubCoachAssignment" / "WorkoutPlan" outside the policy
--     graph — cf. app.is_subcoach_of — and a never-inlined body cannot re-enter the
--     ClientWorkoutAssignment policy graph, 42P17). They answer about an ARBITRARY (actor, object)
--     pair, so EXECUTE is granted to service_role only (BYPASSRLS; the application's own pool). anon
--     and authenticated cannot call them: a JWT session may not probe whether coach X coaches client Y.
--   * CALLER-BOUND WRAPPERS app.caller_coaches_client(client) / app.caller_owns_workout_plan(plan):
--     SECURITY DEFINER (so they may call the workers their caller may not), each resolving the actor
--     ITSELF via app.rls_actor_id() and passing it to the worker. Their only argument is the object
--     id; they can answer only "may I, the invoking principal, act on this object". EXECUTE to
--     service_role, anon, authenticated. The policy calls ONLY these.
-- Repo precedent for a two-id definer helper: app.is_user_coached_by (20260607000000) — which is
-- exactly the oracle shape this migration avoids exposing to the API roles.
--
-- Backend note (R593-c7B-02 / R593-c7B2-C02, reported, not fixed here): the backend today connects
-- with the database owner credentials (`postgres` per .env.example — superuser/BYPASSRLS, not the
-- PostgREST `service_role`) and its RlsContextInterceptor (src/common/interceptors/rls-context.interceptor.ts)
-- guards on `user.sub`, a field the Prisma User row it receives does not carry, so in production no
-- principal currently carries app.current_user_id on this table. The GUC branch is therefore
-- defence in depth for a future non-bypass backend role; it is admitted only for that role class.
--
-- FIX:
--   0. NEW app.rls_principal(): SECURITY INVOKER, STABLE; the effective invoking role name
--      (`role` GUC, else SESSION_USER) — valid inside definer bodies.
--   1. NEW app.rls_actor_id(): SECURITY INVOKER, STABLE, search_path = ''; resolves the actor per
--      principal class as above.
--   2. app.current_user_owns_workout_plan(text) (20270125000011) is DROPPED and replaced by
--      app.actor_owns_workout_plan(actor_id text, plan_id text): same STABLE / SECURITY DEFINER /
--      search_path = '' hardening and ACL; the predicate takes the actor instead of reading
--      auth.uid(). It still exists to keep "WorkoutPlan" out of the ClientWorkoutAssignment policy
--      graph (42P17).
--   3. NEW app.actor_coaches_client(actor_id text, client_user_id text): SECURITY DEFINER (same
--      pattern) because the predicate reads "User" and "SubCoachAssignment" (the policy evaluator
--      may not itself read "SubCoachAssignment" — cf. app.is_subcoach_of) and because a
--      never-inlined function body cannot re-enter the ClientWorkoutAssignment policy graph.
--   3b. NEW caller-bound wrappers app.caller_coaches_client(text) / app.caller_owns_workout_plan(text)
--      (SECURITY DEFINER; actor = app.rls_actor_id()); the workers' EXECUTE is service_role-only.
--   4. `assignment_coach_manage` is recreated with app.rls_actor_id() as the only identity and the
--      caller-bound tenancy wrapper ANDed into BOTH USING and WITH CHECK. Every other condition of the
--      20270125000011 policy is preserved in meaning: person_id IS NULL, assigned_by_coach_id =
--      actor, actor role IN (coach, owner) read from "User", and the plan-ownership helper in
--      WITH CHECK.
--
-- EFFECT (RLS-bound principals; the application's Prisma connection is the `postgres` owner role,
-- BYPASSRLS — the policy never runs for it, hence the application gate in SubCoachScopeService):
--   * a JWT coach (authenticated + auth.uid()) can INSERT / SELECT / UPDATE / DELETE assignments only
--     for clients the app considers theirs; UPDATE cannot re-point client_id to another coach's
--     client (WITH CHECK). A forged app.current_user_id GUC changes nothing for that principal;
--   * a backend-class role with the GUC gets the same rule on the GUC identity; a JWT claim alone
--     is not an identity for that class;
--   * assignments a coach previously created for a client who is not (or no longer) theirs become
--     invisible and immutable to that coach — what assertCanAccessClient would answer. No data is
--     changed and no backfill is performed; whether such rows EXIST in production has not been
--     measured (evidence gap recorded in the PR);
--   * person-owned rows (S8-D3) remain service_role-only: person_id IS NULL is unchanged.
--
-- HARDENING (repo precedent 20270125000011 / 20261212000000 / 20260704000000): helpers STABLE,
-- `SET search_path = ''` with every reference schema-qualified, EXECUTE revoked from PUBLIC; the
-- policy-facing functions (rls_principal, rls_actor_id, caller_* wrappers) granted only to the roles
-- under which the policy is evaluated (service_role, authenticated, anon — anon needs EXECUTE so its
-- refusal stays a POLICY refusal, 42501 on the row); the two-id workers granted to service_role only.
-- A future non-BYPASSRLS backend role needs EXECUTE on the policy-facing functions (R593-c7A2-03).
--
-- LOCKS: CREATE / DROP FUNCTION are catalog-only; DROP/CREATE POLICY takes a short ACCESS
-- EXCLUSIVE on "ClientWorkoutAssignment" (same profile as every prior policy rewrite on this table).
-- Atomic. ROLLBACK: down.sql restores the 20270125000011 policy text, helper body, comment and ACL
-- verbatim and drops the six D8 functions.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS app;

-- 0. The effective invoking role, readable inside SECURITY DEFINER bodies too: the `role` GUC that
--    SET ROLE maintains ('none' when no SET ROLE is in effect), else the login role.
CREATE OR REPLACE FUNCTION app.rls_principal()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT COALESCE(NULLIF(pg_catalog.current_setting('role', true), 'none'), SESSION_USER::text)
$$;

COMMENT ON FUNCTION app.rls_principal() IS
  'RLS principal-class probe (D8, 20270125000012): the effective invoking role — the `role` GUC set by SET ROLE (PostgREST switches to anon/authenticated this way), else SESSION_USER. Unlike CURRENT_USER it is unchanged inside a SECURITY DEFINER body, so the caller-bound wrappers can resolve the real caller.';

REVOKE ALL ON FUNCTION app.rls_principal() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.rls_principal() TO service_role, anon, authenticated;

-- 1. Actor resolution by principal class (SECURITY INVOKER; keyed on app.rls_principal()).
CREATE OR REPLACE FUNCTION app.rls_actor_id()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN app.rls_principal() IN ('anon', 'authenticated') THEN
      -- PostgREST / JWT principal: only the authenticated JWT subject identifies the actor.
      (SELECT u."id" FROM public."User" u WHERE u."supabase_id" = auth.uid()::text)
    ELSE
      -- Backend-class role (database credentials, no JWT): the per-request backend GUC.
      app.current_user_id()
  END
$$;

COMMENT ON FUNCTION app.rls_actor_id() IS
  'RLS actor resolution by SQL principal class (D8, 20270125000012). anon/authenticated (PostgREST JWT roles, per app.rls_principal()): the User whose supabase_id is auth.uid(); the app.current_user_id GUC is ignored because those sessions can set it. Any other non-BYPASSRLS role (backend credentials): app.current_user_id(). SECURITY INVOKER; the principal class comes from app.rls_principal(), which is also correct inside the caller-bound definer wrappers.';

REVOKE ALL ON FUNCTION app.rls_actor_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.rls_actor_id() TO service_role, anon, authenticated;

-- 2. The policy depends on the 20270125000011 helper: drop the policy first, then that helper.
DROP POLICY IF EXISTS "assignment_coach_manage" ON public."ClientWorkoutAssignment";
DROP FUNCTION IF EXISTS app.current_user_owns_workout_plan(text);
-- Round-1 shape of this migration (never merged); harmless on a fresh chain.
DROP FUNCTION IF EXISTS app.current_user_coaches_client(text);

-- 3. Plan-ownership helper, keyed on the supplied actor (replaces app.current_user_owns_workout_plan).
CREATE OR REPLACE FUNCTION app.actor_owns_workout_plan(actor_id text, plan_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT actor_id IS NOT NULL
     AND plan_id IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public."WorkoutPlan" wp
       WHERE wp."id" = plan_id
         AND wp."coach_id" = actor_id
     )
$$;

COMMENT ON FUNCTION app.actor_owns_workout_plan(text, text) IS
  'Security-definer RLS helper (D8, 20270125000012): true when the WorkoutPlan with plan_id is owned (coach_id) by actor_id. Takes the actor as an argument and decides no identity itself. WORKER: EXECUTE for service_role only — the policy calls it through the caller-bound app.caller_owns_workout_plan(text). Exists to break the WorkoutPlan <-> ClientWorkoutAssignment policy cycle; used by assignment_coach_manage WITH CHECK. Replaces app.current_user_owns_workout_plan(text) from 20270125000011.';

-- WORKER: arbitrary (actor, plan) pair → service_role only (R593-c7A2-02). The policy reaches it
-- through app.caller_owns_workout_plan(text), owned by the migration runner.
REVOKE ALL ON FUNCTION app.actor_owns_workout_plan(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.actor_owns_workout_plan(text, text) TO service_role;

-- 4. Coach-client tenancy helper: WorkoutBuilderService.assertCanAccessClient /
--    SubCoachScopeService.canActOnClient at the DB layer, keyed on the supplied actor.
CREATE OR REPLACE FUNCTION app.actor_coaches_client(actor_id text, client_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT actor_id IS NOT NULL
     AND client_user_id IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public."User" caller
       JOIN public."User" client ON client."id" = client_user_id
       WHERE caller."id" = actor_id
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

COMMENT ON FUNCTION app.actor_coaches_client(text, text) IS
  'Security-definer RLS helper (D8, 20270125000012): true when actor_id may act on the supplied client User.id under the application rule WorkoutBuilderService.assertCanAccessClient / SubCoachScopeService.canActOnClient — the target''s coach_id is the actor, OR the actor is a sub-coach (role coach, coach_id set) with an open SubCoachAssignment to that live student. Takes the actor as an argument and decides no identity itself. WORKER: EXECUTE for service_role only — the policy calls it through the caller-bound app.caller_coaches_client(text).';

-- WORKER: arbitrary (actor, client) pair → service_role only (R593-c7A2-02). anon/authenticated may
-- not ask whether coach X coaches client Y; they reach it only through the caller-bound wrapper.
REVOKE ALL ON FUNCTION app.actor_coaches_client(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.actor_coaches_client(text, text) TO service_role;

-- 4b. Caller-bound wrappers: the ONLY tenancy entry points for the API roles. SECURITY DEFINER so
--     they may execute the workers; the actor is resolved INSIDE from the invoking principal
--     (app.rls_principal() → app.rls_actor_id()), never taken as an argument.
CREATE OR REPLACE FUNCTION app.caller_coaches_client(client_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT app.actor_coaches_client(app.rls_actor_id(), client_user_id)
$$;

COMMENT ON FUNCTION app.caller_coaches_client(text) IS
  'Caller-bound RLS helper (D8, 20270125000012): true when the INVOKING principal (app.rls_actor_id(), resolved inside) may act on the supplied client User.id under the application rule. Security definer only so it can execute the service_role-only worker app.actor_coaches_client(text, text); it exposes no arbitrary (actor, client) query to anon/authenticated. Called by assignment_coach_manage USING and WITH CHECK.';

REVOKE ALL ON FUNCTION app.caller_coaches_client(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.caller_coaches_client(text) TO service_role, anon, authenticated;

CREATE OR REPLACE FUNCTION app.caller_owns_workout_plan(plan_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT app.actor_owns_workout_plan(app.rls_actor_id(), plan_id)
$$;

COMMENT ON FUNCTION app.caller_owns_workout_plan(text) IS
  'Caller-bound RLS helper (D8, 20270125000012): true when the INVOKING principal (app.rls_actor_id(), resolved inside) owns the supplied WorkoutPlan. Security definer only so it can execute the service_role-only worker app.actor_owns_workout_plan(text, text). Called by assignment_coach_manage WITH CHECK.';

REVOKE ALL ON FUNCTION app.caller_owns_workout_plan(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.caller_owns_workout_plan(text) TO service_role, anon, authenticated;

-- 5. The policy: one actor resolution (app.rls_actor_id()), caller-bound tenancy in USING and WITH CHECK.
CREATE POLICY "assignment_coach_manage"
    ON public."ClientWorkoutAssignment"
    AS PERMISSIVE
    FOR ALL
    TO PUBLIC
    USING (
        "person_id" IS NULL
        AND app.rls_actor_id() IS NOT NULL
        AND "assigned_by_coach_id" = app.rls_actor_id()
        AND EXISTS (
            SELECT 1
            FROM "User" u
            WHERE u."id" = app.rls_actor_id()
              AND u."role" IN ('coach', 'owner')
        )
        AND app.caller_coaches_client("client_id")
    )
    WITH CHECK (
        "person_id" IS NULL
        AND app.rls_actor_id() IS NOT NULL
        AND "assigned_by_coach_id" = app.rls_actor_id()
        AND EXISTS (
            SELECT 1
            FROM "User" u
            WHERE u."id" = app.rls_actor_id()
              AND u."role" IN ('coach', 'owner')
        )
        AND app.caller_coaches_client("client_id")
        AND app.caller_owns_workout_plan("workout_plan_id")
    );

COMMIT;
