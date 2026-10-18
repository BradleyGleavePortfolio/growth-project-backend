-- C6-B1: a space has a kind (chat, announcement, section) and a posting policy
-- (all, coach). Nobody starts a message in a section; in a coach-only space
-- only the workspace coach does. Replies (post and challenge comments, challenge
-- opt-ins) follow the space's access rule alone. Existing spaces stay chat/all.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TYPE "CommunitySpaceKind" AS ENUM ('chat', 'announcement', 'section');
CREATE TYPE "CommunityPostingPolicy" AS ENUM ('all', 'coach');

ALTER TABLE "community_cohorts" ADD COLUMN "kind" "CommunitySpaceKind" NOT NULL DEFAULT 'chat',
ADD COLUMN "posting_policy" "CommunityPostingPolicy" NOT NULL DEFAULT 'all';

CREATE FUNCTION app.community_can_post(p_cohort_id uuid, p_user_id text, p_reply boolean)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM public."community_cohorts" c
    JOIN public."community_workspaces" w ON w."id" = c."workspace_id"
    WHERE c."id" = p_cohort_id
      AND c."kind" <> 'section'
      AND (p_reply OR c."posting_policy" = 'all' OR w."coach_id" = p_user_id)
  )
$fn$;
ALTER FUNCTION app.community_can_post(uuid, text, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION app.community_can_post(uuid, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.community_can_post(uuid, text, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION app.community_can_post(uuid, text, boolean) TO authenticated, service_role;
COMMENT ON FUNCTION app.community_can_post(uuid, text, boolean) IS
  '20270502004600: the space takes this message. A section takes none; a coach-only space takes a new message from its coach only; p_reply (a comment or challenge opt-in row) needs only the access rule.';

-- RESTRICTIVE: ANDs with community_messages_author_insert, which stays as
-- 20270502000200 wrote it, so the two compose in any order.
CREATE POLICY "community_messages_space_takes_insert" ON "community_messages" AS RESTRICTIVE FOR INSERT TO public
  WITH CHECK (
    "scope" <> 'cohort' OR "cohort_id" IS NULL
    OR app.community_can_post("cohort_id", "sender_id",
         COALESCE("plan_context_type", '') IN ('community_post_comment', 'community_challenge_comment', 'community_challenge_optin'))
  );
COMMENT ON POLICY "community_messages_space_takes_insert" ON "community_messages" IS
  '20270502004600: restrictive. A space message is inserted only when app.community_can_post lets the sender start it (or reply, for a comment or challenge opt-in row). DMs and Hall rows pass.';

COMMIT;
