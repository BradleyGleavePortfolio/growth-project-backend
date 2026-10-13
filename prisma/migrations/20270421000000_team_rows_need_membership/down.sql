-- Down for 20270421000000_team_rows_need_membership (SUBREVOKE2).
-- Restores app.is_subcoach_on_coach_team and app.community_win_teammate_visible
-- verbatim (20261215000000_mwb_1_data_model and
-- 20270211000000_community_reports_voice_notes_and_wins) and drops the
-- restrictive policy. This brings back the bare coach_id grant.
-- No data to restore.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

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
       WHERE u."id" = app.current_user_id()
         AND u."role" = 'coach'
         AND u."coach_id" = head_coach_user_id
     )
$$;
COMMENT ON FUNCTION app.is_subcoach_on_coach_team(text) IS
  'Security-definer RLS helper: true when app.current_user_id() is a sub-coach (role=coach with a non-null coach_id) on the supplied head coach''s team.';

DROP POLICY IF EXISTS "p_workoutprogram_shared_needs_team" ON "WorkoutProgram";

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
  'A-610-2: caller is a teammate of the win author (viewer AND author currently belong to the win coach, the coach runs a live community workspace, neither side banned there, no block either way). SECURITY DEFINER with a pinned search_path and schema-qualified relations.';

COMMIT;
