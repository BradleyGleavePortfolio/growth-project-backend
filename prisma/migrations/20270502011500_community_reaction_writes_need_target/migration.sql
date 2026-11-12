-- DM-REACTION-WRITE-RLS-BE (LS-1245R2 C1 and the write half of its C2, AUDIT 6776313449; [W2] "RLS for everything"): at
-- the row layer a reaction row is now written only where the API would let that row's reactor make that reaction
-- (resolveTarget, src/community/reactions/community-reactions.service.ts:95-163). Before this, the two policies that
-- let a reaction row in, community_responses_own_insert and community_responses_coach_all's WITH CHECK
-- (20261212000000), tested who the reactor is and that they belong to the community, never the target: a member
-- outside a DM could file a reaction on it, and its two people would then read it.
-- 1. New function app.community_response_target_open(workspace, target_type, target_id, user): true only when the
--    user is not NULL and the target is a live row (deleted_at NULL) of that same workspace: a community_messages
--    row for 'message' or 'comment' (a 'comment' only for a post comment row, plan_context_type
--    'community_post_comment', and a 'message' never for one), or a community_posts row for 'post'; the user may
--    open its place (app.community_can_access for a space; for the Hall or a DM, app.community_workspace_open, or
--    the caller himself as the workspace coach, app.is_community_workspace_coach, as canAccessWorkspace lets him in
--    with no space that is not public); the user is its author or the author stays (app.community_author_stays), is
--    not banned there (app.community_author_unbanned) and is not in a block with the user (app.users_in_block); and,
--    for a DM row, the user is its sender or its recipient and the two are not in a block. False for 'event',
--    'challenge', a missing row and any NULL. It matches the message on id alone (the key leads with id). It is
--    SECURITY DEFINER (owner postgres, which bypasses row security) because a lookup under the caller's own row
--    security would hide target rows the API lets them react to (a Hall comment row reads for the coach only). It
--    answers yes or no and shows no row. Run rights: authenticated and service_role, not PUBLIC or anon.
-- 2. community_responses_target_open_insert, RESTRICTIVE FOR INSERT: the row's user is the caller and the function
--    says yes. It ANDs with both permissive arms (own_insert and coach_all's WITH CHECK), which stay as they are, so
--    the coach no longer files a reaction under another person's name, nor anyone one the API would refuse.
-- 3. community_responses_target_open_update, RESTRICTIVE FOR UPDATE with WITH CHECK only (no USING): an updated row
--    may land only where its own reactor could have made it. It changes no row anyone's UPDATE reaches. The reactor
--    test stays off UPDATE: the coach still edits a member's reaction on a space row as today.
-- Not here: the DM-open test (both people still in the community, assertDmOpen, community-dms.service.ts:48-58): no
-- existing helper matches it (app.community_workspace_open lets in a client with no membership row through a space
-- of visibility 'clients'), so it is left out, DM-REACTION-OPEN-RLS. DELETE, every read, every existing policy,
-- table, column, index, table grant and data are unchanged. The app connects as a role that bypasses row security,
-- so no request path changes; this binds any writer that runs as authenticated with app.current_user_id set.
-- Reverse: down.sql. Live proof: test/dm-reaction-write-rls-be.spec.ts.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION app.community_response_target_open(p_workspace_id uuid, p_target_type "CommunityResponseTargetType",
  p_target_id uuid, p_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT coalesce(p_user_id IS NOT NULL AND p_workspace_id IS NOT NULL AND (
    (p_target_type IN ('message', 'comment') AND EXISTS (
      SELECT 1 FROM public."community_messages" m
      WHERE m."id" = p_target_id
        AND m."workspace_id" = p_workspace_id
        AND m."deleted_at" IS NULL
        AND coalesce(m."plan_context_type" = 'community_post_comment', false) = (p_target_type = 'comment')
        AND CASE WHEN m."cohort_id" IS NOT NULL THEN app.community_can_access(m."cohort_id", p_user_id)
                 ELSE (app.community_workspace_open(p_workspace_id, p_user_id)
                       OR (p_user_id = app.current_user_id() AND app.is_community_workspace_coach(p_workspace_id))) END
        AND (m."sender_id" = p_user_id
             OR (app.community_author_stays(p_workspace_id, m."cohort_id", m."sender_id")
                 AND app.community_author_unbanned(p_workspace_id, m."sender_id")
                 AND NOT app.users_in_block(p_user_id, m."sender_id")))
        AND (m."scope" <> 'dm'
             OR (p_user_id IN (m."sender_id", m."recipient_user_id")
                 AND NOT app.users_in_block(m."sender_id", m."recipient_user_id")))
    ))
    OR (p_target_type = 'post' AND EXISTS (
      SELECT 1 FROM public."community_posts" p
      WHERE p."id" = p_target_id
        AND p."workspace_id" = p_workspace_id
        AND p."deleted_at" IS NULL
        AND CASE WHEN p."cohort_id" IS NOT NULL THEN app.community_can_access(p."cohort_id", p_user_id)
                 ELSE (app.community_workspace_open(p_workspace_id, p_user_id)
                       OR (p_user_id = app.current_user_id() AND app.is_community_workspace_coach(p_workspace_id))) END
        AND (p."author_id" = p_user_id
             OR (app.community_author_stays(p_workspace_id, p."cohort_id", p."author_id")
                 AND app.community_author_unbanned(p_workspace_id, p."author_id")
                 AND NOT app.users_in_block(p_user_id, p."author_id")))
    ))
  ), false)
$fn$;
ALTER FUNCTION app.community_response_target_open(uuid, "CommunityResponseTargetType", uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app.community_response_target_open(uuid, "CommunityResponseTargetType", uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.community_response_target_open(uuid, "CommunityResponseTargetType", uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION app.community_response_target_open(uuid, "CommunityResponseTargetType", uuid, text) TO authenticated, service_role;
COMMENT ON FUNCTION app.community_response_target_open(uuid, "CommunityResponseTargetType", uuid, text) IS
  '20270502011500: true only when the user may make this reaction as the API would: a live message, comment or post of that workspace, a place the user may open, an author who stays, is not banned and is not in a block with the user, and for a DM one of its two people while they are not in a block. False for event, challenge, a missing row and any NULL. DEFINER, so the caller''s row security cannot hide the target.';

-- RESTRICTIVE: each ANDs with the permissive community_responses_own_insert and community_responses_coach_all,
-- which stay as 20261212000000 and 20270502011400 left them, so they compose in any order.
CREATE POLICY "community_responses_target_open_insert" ON "community_responses" AS RESTRICTIVE FOR INSERT TO public
  WITH CHECK ("user_id" = app.current_user_id() AND app.community_response_target_open("workspace_id", "target_type", "target_id", "user_id"));
COMMENT ON POLICY "community_responses_target_open_insert" ON "community_responses" IS
  '20270502011500: restrictive. A reaction row is inserted only under the caller''s own name and only where app.community_response_target_open lets that reactor make it.';

CREATE POLICY "community_responses_target_open_update" ON "community_responses" AS RESTRICTIVE FOR UPDATE TO public
  WITH CHECK (app.community_response_target_open("workspace_id", "target_type", "target_id", "user_id"));
COMMENT ON POLICY "community_responses_target_open_update" ON "community_responses" IS
  '20270502011500: restrictive, WITH CHECK only. An updated reaction row may land only where its own reactor could make it; no USING, so it changes no row an UPDATE reaches.';

COMMIT;
