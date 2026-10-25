-- SC-BE1 (agent 167; FX-1135, agent 169: renumbered from 20270502008300 so it
-- sorts above 20270502008900): text replies in the space chat follow the voice
-- reply rule of 20270502007900, so text and voice replies obey one rule. One
-- existing policy and one existing function body change; no table or column.
--
-- community_messages_space_takes_insert (restrictive) now counts a plain TEXT
-- message as a reply, exactly as a voice message (app.community_voice_reply).
-- That parent is now a live plain FIRST message of the same space (a reply to a
-- reply joins its thread) started by someone who may start one there: in a
-- coach-only space such as Announcements a member answers the coach's threads
-- only (plan section 3); a top-level message there still needs the start
-- permission; a section still takes nothing. The coach passes on their own
-- start right. The server's service-role connection bypasses RLS and applies
-- the same rule (CommunityMessagesService.replyParent). Live proof:
-- test/rls/community-text-replies-rls.spec.ts. Reverse: down.sql.

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
      AND p."parent_message_id" IS NULL
      AND app.community_can_post(p_cohort_id, p."sender_id", false)
  )
$fn$;
COMMENT ON FUNCTION app.community_voice_reply(uuid, uuid, timestamptz) IS
  '20270502009000: the parent of a text or voice reply is a live plain first message of the same space, started by someone who may start one there (in a coach-only space, its coach).';

ALTER POLICY "community_messages_space_takes_insert" ON "community_messages"
  WITH CHECK (
    "scope" <> 'cohort' OR "cohort_id" IS NULL
    OR app.community_can_post("cohort_id", "sender_id",
         COALESCE("plan_context_type", '') IN ('community_post_comment', 'community_challenge_comment', 'community_challenge_optin')
         OR ("kind" IN ('text', 'voice') AND "plan_context_type" IS NULL AND "parent_message_id" IS NOT NULL
             AND app.community_voice_reply("cohort_id", "parent_message_id", "parent_message_at")))
  );
COMMENT ON POLICY "community_messages_space_takes_insert" ON "community_messages" IS
  '20270502009000: restrictive. A space message is inserted only when app.community_can_post lets the sender start it (or reply, for a comment, a challenge opt-in, or a text or voice message answering a thread app.community_voice_reply accepts). DMs and Hall rows pass.';

COMMIT;
