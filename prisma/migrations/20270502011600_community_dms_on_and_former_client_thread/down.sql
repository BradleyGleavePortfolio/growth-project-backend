-- Reverse of 20270502011600_community_dms_on_and_former_client_thread, for a confirmed defect only: a coach and a
-- former client lose their DM thread again at the row layer (the coach no longer reads what the former client wrote
-- there, neither inserts a DM to the other, the former client neither reads nor inserts a reaction there), and a new
-- community starts with direct messages off. One transaction, in reverse order:
-- 1. app.community_response_target_open back to 20270502011500's body and comment, verbatim (b#1248).
-- 2. DROP the three permissive policies 20270502011600 added.
-- 3. community_messages_author_stays back to 20270502006400's USING, verbatim.
-- 4. DROP the two functions (no CASCADE: no policy calls them any more).
-- 5. The column default of community_workspaces.dm_enabled_default back to false.
-- FORWARD-ONLY, not reversed here: the UPDATE that set every existing community's dm_enabled_default to true. Those
-- rows keep true (a false cannot be told apart from the old default); a community that wants DMs off needs a new
-- forward migration plus a coach switch job ("203-D11 op 2"). No table, column, index, table grant or other data
-- changes.

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

DROP POLICY "community_responses_dm_former_client_insert" ON "community_responses";

DROP POLICY "community_responses_dm_former_client_select" ON "community_responses";

DROP POLICY "community_messages_dm_former_client_insert" ON "community_messages";

ALTER POLICY "community_messages_author_stays" ON "community_messages"
  USING ("sender_id" = app.current_user_id() OR app.community_author_stays("workspace_id", "cohort_id", "sender_id"));

DROP FUNCTION app.community_dm_former_client_target(uuid, "CommunityResponseTargetType", uuid, text);

DROP FUNCTION app.community_dm_former_client(uuid, text, text);

ALTER TABLE "community_workspaces" ALTER COLUMN "dm_enabled_default" SET DEFAULT false;

COMMIT;
