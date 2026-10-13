-- SUBREVOKE2 (agent 142): a bare User.coach_id is not team membership at the
-- row layer. A sub-coach whose seat was archived kept reading the head coach's
-- tenant_shared programs and their revisions, because app.is_subcoach_on_coach_team
-- and the tenant_shared branch of p_workoutprogram_select both trusted the
-- caller's coach_id alone. The app has refused that since C13 (SubCoachScopeService).
--
-- Team membership, judged per head coach (the #978 rule, keyed on the head
-- coach passed in, so a sub-coach on two teams is judged separately for each):
--   * an active TeamSubCoachAssignment seat (head coach, caller), or
--   * a never-seated legacy pair: no seat row at all for (head coach, caller),
--     the caller's coach_id names that head coach, and that head coach has an
--     open SubCoachAssignment to the caller.
-- An archived seat always wins over an open delegation: removal is final.
-- The caller must have role coach. The head coach is not their own sub-coach.
--
-- 1. app.is_subcoach_on_coach_team(text): the membership rule above. Its
--    callers inherit it: p_workoutprogramrevision_select and the four
--    p_workoutplanrevision policies.
-- 2. p_workoutprogram_shared_needs_team: a RESTRICTIVE policy that ANDs with
--    p_workoutprogram_select/insert/update/delete. A tenant_shared row passes
--    only for an owner admin, the tenant's own coach, or a member of the tenant
--    coach's team. It fences the bare coach_id clause in p_workoutprogram_select
--    without rewriting that policy, so it composes with #976, which ALTERs it,
--    in either merge order. The same check on writes stops a non-member from
--    publishing a tenant_shared row into someone else's tenant.
--    p_workoutprogram_select_team_shared: a PERMISSIVE SELECT policy that lets
--    a team member read the tenant coach's shared library masters, so a
--    sub-coach whose coach_id names another head coach is not refused on the
--    team they are seated on. Masters only (is_template, no client_id), which
--    #976's tenant rule always admits.
-- 3. app.community_win_teammate_visible(text, text): a coach-role viewer must
--    also be on the win coach's team. Students, owners and every other check
--    are unchanged.
--
-- No data changes. service_role and the migration role bypass RLS.
-- Reversible: down.sql restores both functions and drops both policies.
-- Live proof: test/rls/team-membership-rows-rls.spec.ts (rls-live-tests).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- 1. Team membership per head coach -------------------------------------------
CREATE OR REPLACE FUNCTION app.is_subcoach_on_coach_team(head_coach_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT head_coach_user_id IS NOT NULL
     AND app.current_user_id() IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public."User" u
       LEFT JOIN public."TeamSubCoachAssignment" seat
         ON seat."head_coach_id" = head_coach_user_id
        AND seat."sub_coach_id" = u."id"
       WHERE u."id" = app.current_user_id()
         AND u."id" <> head_coach_user_id
         AND u."role" = 'coach'
         AND (
           (seat."id" IS NOT NULL AND seat."archived_at" IS NULL)
           OR (
             seat."id" IS NULL
             AND u."coach_id" = head_coach_user_id
             AND EXISTS (
               SELECT 1
               FROM public."SubCoachAssignment" d
               WHERE d."head_coach_id" = head_coach_user_id
                 AND d."sub_coach_id" = u."id"
                 AND d."unassigned_at" IS NULL
             )
           )
         )
     )
$$;
COMMENT ON FUNCTION app.is_subcoach_on_coach_team(text) IS
  'Security-definer RLS helper: true when app.current_user_id() (role coach) is on the supplied head coach''s team - an active TeamSubCoachAssignment seat with that head coach, or, with no seat row for the pair, coach_id = that head coach plus an open SubCoachAssignment from them. A bare coach_id is not membership. SUBREVOKE2.';

-- 2. Shared programs need team membership -------------------------------------
DROP POLICY IF EXISTS "p_workoutprogram_shared_needs_team" ON "WorkoutProgram";
CREATE POLICY "p_workoutprogram_shared_needs_team" ON "WorkoutProgram" AS RESTRICTIVE FOR ALL TO public
  USING (("visibility" <> 'tenant_shared' OR app.is_owner() OR "coach_id" = app.current_user_id() OR app.is_subcoach_on_coach_team("coach_id")))
  WITH CHECK (("visibility" <> 'tenant_shared' OR app.is_owner() OR "coach_id" = app.current_user_id() OR app.is_subcoach_on_coach_team("coach_id")));
COMMENT ON POLICY "p_workoutprogram_shared_needs_team" ON "WorkoutProgram" IS
  'SUBREVOKE2: restrictive. A tenant_shared program is read or written only by an owner admin, its tenant coach, or a member of that coach''s team (app.is_subcoach_on_coach_team). Fences the bare coach_id clause of p_workoutprogram_select.';

DROP POLICY IF EXISTS "p_workoutprogram_select_team_shared" ON "WorkoutProgram";
CREATE POLICY "p_workoutprogram_select_team_shared" ON "WorkoutProgram" AS PERMISSIVE FOR SELECT TO public
  USING (("visibility" = 'tenant_shared' AND "is_template" AND "client_id" IS NULL AND app.is_subcoach_on_coach_team("coach_id")));
COMMENT ON POLICY "p_workoutprogram_select_team_shared" ON "WorkoutProgram" IS
  'SUBREVOKE2: a member of the tenant coach''s team (app.is_subcoach_on_coach_team, judged per head coach) may SELECT that tenant''s tenant_shared library masters.';

-- 3. Community wins: a coach-role teammate needs team membership ---------------
CREATE OR REPLACE FUNCTION app.community_win_teammate_visible(p_author_id text, p_coach_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $function$
  SELECT app.current_user_id() IS NOT NULL
     AND p_coach_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public."User" v
       WHERE v."id" = app.current_user_id()
         AND v."coach_id" = p_coach_id
         AND v."deleted_at" IS NULL
         AND (v."role"::text <> 'coach' OR app.is_subcoach_on_coach_team(p_coach_id))
     )
     AND app.community_win_author_coach(p_author_id) = p_coach_id
     AND EXISTS (
       SELECT 1 FROM public."community_workspaces" w
       WHERE w."coach_id" = p_coach_id
         AND w."archived_at" IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM public."community_workspace_bans" b
           WHERE b."workspace_id" = w."id"
             AND b."lifted_at" IS NULL
             AND b."user_id" IN (app.current_user_id(), p_author_id)
         )
     )
     AND NOT EXISTS (
       SELECT 1 FROM public."UserBlock" ub
       WHERE (ub."blocker_id" = app.current_user_id() AND ub."blocked_id" = p_author_id)
          OR (ub."blocker_id" = p_author_id AND ub."blocked_id" = app.current_user_id())
     )
$function$;

COMMENT ON FUNCTION app.community_win_teammate_visible(text, text) IS
  'A-610-2: caller is a teammate of the win author (viewer AND author currently belong to the win coach, the coach runs a live community workspace, neither side banned there, no block either way). A coach-role viewer must also be on the win coach''s team (app.is_subcoach_on_coach_team, SUBREVOKE2). SECURITY DEFINER with a pinned search_path and schema-qualified relations.';

COMMIT;
