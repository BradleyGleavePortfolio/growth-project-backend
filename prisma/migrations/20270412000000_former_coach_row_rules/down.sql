-- Reverse of 20270412000000_former_coach_row_rules. Only for a confirmed
-- defect: it lets a coach read and write a moved client's former rows again
-- through direct table access, and any signed-in user write into any thread
-- as its sender.

SET lock_timeout = '5s';

DROP POLICY IF EXISTS "coach_message_client_history_read" ON "CoachMessage";

ALTER POLICY "coach_message_participant_access" ON "CoachMessage"
  USING (
    app.current_user_id() IS NOT NULL
    AND (
      "coach_id" = app.current_user_id()
      OR "client_id" = app.current_user_id()
      OR "sender_id" = app.current_user_id()
    )
  )
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND (
      "coach_id" = app.current_user_id()
      OR "client_id" = app.current_user_id()
      OR "sender_id" = app.current_user_id()
    )
  );

ALTER POLICY "conversation_review_participant_access" ON "ConversationReview"
  USING (
    app.current_user_id() IS NOT NULL
    AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id())
  )
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id())
  );

ALTER POLICY "coach_thread_state_self_access" ON "CoachThreadState"
  USING (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND "user_id" = app.current_user_id()
    AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id())
  );

ALTER POLICY "invite_code_coach_owner_access" ON "InviteCode"
  USING (
    app.current_user_id() IS NOT NULL
    AND ("coach_id" = app.current_user_id() OR "invited_by_user_id" = app.current_user_id())
  )
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND ("coach_id" = app.current_user_id() OR "invited_by_user_id" = app.current_user_id())
  );

ALTER POLICY "p_inviteredemption_select" ON "InviteRedemption"
  USING (app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id()));

RESET lock_timeout;
