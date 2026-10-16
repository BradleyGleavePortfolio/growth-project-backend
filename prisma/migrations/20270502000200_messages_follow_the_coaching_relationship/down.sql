-- Reverse of 20270502000200_messages_follow_the_coaching_relationship. Only
-- for a confirmed defect: it reopens G02 (the new coach reads the former
-- coach's nudges; clients write nudges), G03 (the client writes and deletes
-- the coach's review marker) and G04 (DMs into any workspace, to anyone).
-- Restores verbatim the CoachNudge text and comments of 20261212010000, the
-- community_messages_author_insert text of 20261212000000, and the
-- ConversationReview text of 20270412000000 (#973, which merges first).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER POLICY "p_coachnudge_select" ON "CoachNudge"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_coachnudge_select" ON "CoachNudge" IS 'PR-RLS-02: owner, the nudge coach, the nudge client, or the client''s current coach may read.';
ALTER POLICY "p_coachnudge_insert" ON "CoachNudge"
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_coachnudge_insert" ON "CoachNudge" IS 'PR-RLS-02: owner, the nudge coach, the nudge client, or the client''s current coach may insert.';
ALTER POLICY "p_coachnudge_update" ON "CoachNudge"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))))
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_coachnudge_update" ON "CoachNudge" IS 'PR-RLS-02: owner, the nudge coach, the nudge client, or the client''s current coach may update.';
ALTER POLICY "p_coachnudge_delete" ON "CoachNudge"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_coachnudge_delete" ON "CoachNudge" IS 'PR-RLS-02: owner, the nudge coach, the nudge client, or the client''s current coach may delete.';

DROP POLICY "conversation_review_client_read" ON "ConversationReview";
DROP POLICY "conversation_review_coach_access" ON "ConversationReview";
CREATE POLICY "conversation_review_participant_access" ON "ConversationReview"
  FOR ALL TO public
  USING (
    app.current_user_id() IS NOT NULL
    AND (
      "client_id" = app.current_user_id()
      OR ("coach_id" = app.current_user_id() AND app.is_user_coached_by("client_id", "coach_id"))
    )
  )
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND (
      "client_id" = app.current_user_id()
      OR ("coach_id" = app.current_user_id() AND app.is_user_coached_by("client_id", "coach_id"))
    )
  );

ALTER POLICY "community_messages_author_insert" ON "community_messages"
  WITH CHECK (
    "sender_id"::text = app.current_user_id()
    AND (
      app.is_community_workspace_coach("workspace_id")
      OR ("scope" = 'cohort' AND app.shares_community_cohort("cohort_id"))
      OR ("scope" = 'dm' AND "recipient_user_id" IS NOT NULL)
    )
  );
DROP FUNCTION app.workspace_has_participant(uuid, text);

COMMIT;
