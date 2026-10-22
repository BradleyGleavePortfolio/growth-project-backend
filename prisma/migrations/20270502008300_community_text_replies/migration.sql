-- SC-BE1 (agent 167): text replies in the space chat follow the voice reply
-- rule of 20270502007900, so text and voice replies obey one rule. One existing
-- policy changes; no table, column or function changes.
--
-- community_messages_space_takes_insert (restrictive) now counts a plain TEXT
-- message as a reply, exactly as a voice message: its parent is a live plain
-- message of the same space (app.community_voice_reply, unchanged). A member
-- may answer in a coach-only space such as Announcements; a top-level message
-- there still needs the start permission; a section still takes nothing.
-- The server's service-role connection bypasses RLS and applies the same rule
-- (CommunityMessagesService.replyParent). Live proof:
-- test/rls/community-text-replies-rls.spec.ts. Reverse: down.sql.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER POLICY "community_messages_space_takes_insert" ON "community_messages"
  WITH CHECK (
    "scope" <> 'cohort' OR "cohort_id" IS NULL
    OR app.community_can_post("cohort_id", "sender_id",
         COALESCE("plan_context_type", '') IN ('community_post_comment', 'community_challenge_comment', 'community_challenge_optin')
         OR ("kind" IN ('text', 'voice') AND "plan_context_type" IS NULL AND "parent_message_id" IS NOT NULL
             AND app.community_voice_reply("cohort_id", "parent_message_id", "parent_message_at")))
  );
COMMENT ON POLICY "community_messages_space_takes_insert" ON "community_messages" IS
  '20270502008300: restrictive. A space message is inserted only when app.community_can_post lets the sender start it (or reply, for a comment, a challenge opt-in, or a text or voice message whose parent is a live plain message of the same space). DMs and Hall rows pass.';
COMMENT ON FUNCTION app.community_voice_reply(uuid, uuid, timestamptz) IS
  '20270502008300: the parent of a text or voice reply is a live plain message of the same space.';

COMMIT;
