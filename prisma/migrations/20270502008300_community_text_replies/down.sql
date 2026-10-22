-- Down for 20270502008300_community_text_replies (SC-BE1). The policy and the
-- function comment go back to their 20270502007900 text: only voice messages
-- count as replies at the row layer again. Text replies already stored keep
-- their parent link (the older server lists them as plain messages).

BEGIN;
SET LOCAL lock_timeout = '5s';

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
COMMENT ON FUNCTION app.community_voice_reply(uuid, uuid, timestamptz) IS
  '20270502007900: the parent of a voice reply is a live plain message of the same space.';

COMMIT;
