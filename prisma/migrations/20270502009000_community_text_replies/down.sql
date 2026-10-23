-- Down for 20270502009000_community_text_replies (SC-BE1). The policy, the
-- function body and both comments go back to their 20270502007900 text: only
-- voice messages count as replies at the row layer again, to any live plain
-- message of the same space. Text replies already stored keep their parent
-- link (the older server lists them as plain messages).

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION app.community_voice_reply(p_cohort_id uuid, p_parent_id uuid, p_parent_at timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public."community_messages" p
    WHERE p."id" = p_parent_id AND p."created_at" = p_parent_at
      AND p."scope" = 'cohort' AND p."cohort_id" = p_cohort_id
      AND p."deleted_at" IS NULL AND p."plan_context_type" IS NULL
  )
$fn$;
COMMENT ON FUNCTION app.community_voice_reply(uuid, uuid, timestamptz) IS
  '20270502007900: the parent of a voice reply is a live plain message of the same space.';

ALTER POLICY "community_messages_space_takes_insert" ON "community_messages"
  WITH CHECK (
    "scope" <> 'cohort' OR "cohort_id" IS NULL
    OR app.community_can_post("cohort_id", "sender_id",
         COALESCE("plan_context_type", '') IN ('community_post_comment', 'community_challenge_comment', 'community_challenge_optin')
         OR ("kind" = 'voice' AND "plan_context_type" IS NULL AND "parent_message_id" IS NOT NULL
             AND app.community_voice_reply("cohort_id", "parent_message_id", "parent_message_at")))
  );
COMMENT ON POLICY "community_messages_space_takes_insert" ON "community_messages" IS
  '20270502007900: restrictive. A space message is inserted only when app.community_can_post lets the sender start it (or reply, for a comment, a challenge opt-in, or a voice message whose parent is a live plain message of the same space). DMs and Hall rows pass.';

COMMIT;
