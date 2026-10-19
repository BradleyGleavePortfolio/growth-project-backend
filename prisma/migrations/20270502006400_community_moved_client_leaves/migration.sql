-- C6-WINS-MOVE (agent 159; owner: history always follows the client, a former
-- coach loses every read of a moved client): a client who moves to another
-- coach, or to none, leaves the former coach's community. What they wrote in
-- its Hall and in its spaces that are not public no longer reads there for
-- anyone but themselves. Public spaces stay public. The row policies below and
-- the API (CommunitySafetyService, community-space-access.ts) ask the same
-- function. Wins already follow the author's current coach (20270421000000).
-- No column, data or grant on a table changes. Reverse: down.sql.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION app.community_author_stays(p_workspace_id uuid, p_space_id uuid, p_author_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT NOT EXISTS (
    SELECT 1
    FROM public."community_workspaces" w
    JOIN public."User" u ON u."id" = p_author_id
    WHERE w."id" = p_workspace_id
      AND u."role" = 'student'
      AND u."coach_id" IS DISTINCT FROM w."coach_id"
      AND NOT EXISTS (SELECT 1 FROM public."community_cohorts" c
                      WHERE c."id" = p_space_id AND c."visibility" = 'public')
      AND NOT EXISTS (SELECT 1 FROM public."community_memberships" m
                      WHERE m."workspace_id" = w."id" AND m."user_id" = u."id"
                        AND m."role" <> 'student' AND m."status" <> 'removed')
  )
$fn$;
ALTER FUNCTION app.community_author_stays(uuid, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app.community_author_stays(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.community_author_stays(uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION app.community_author_stays(uuid, uuid, text) TO authenticated, service_role;
COMMENT ON FUNCTION app.community_author_stays(uuid, uuid, text) IS
  '20270502006400: false when the author is a client who is no longer the workspace coach''s client (and holds no helper row there) and the row is in the Hall or a space that is not public.';

-- RESTRICTIVE: ANDs with every permissive SELECT policy (the coach's FOR ALL
-- included). The author always reads their own row.
DROP POLICY IF EXISTS "community_posts_author_stays" ON "community_posts";
CREATE POLICY "community_posts_author_stays" ON "community_posts" AS RESTRICTIVE FOR SELECT TO public
  USING ("author_id" = app.current_user_id() OR app.community_author_stays("workspace_id", "cohort_id", "author_id"));

DROP POLICY IF EXISTS "community_messages_author_stays" ON "community_messages";
CREATE POLICY "community_messages_author_stays" ON "community_messages" AS RESTRICTIVE FOR SELECT TO public
  USING ("sender_id" = app.current_user_id() OR app.community_author_stays("workspace_id", "cohort_id", "sender_id"));

DROP POLICY IF EXISTS "community_voice_notes_author_stays" ON "community_voice_notes";
CREATE POLICY "community_voice_notes_author_stays" ON "community_voice_notes" AS RESTRICTIVE FOR SELECT TO public
  USING ("author_id" = app.current_user_id() OR app.community_author_stays("workspace_id", "cohort_id", "author_id"));

COMMIT;
