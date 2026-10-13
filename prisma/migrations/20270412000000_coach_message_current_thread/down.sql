-- Reverse of 20270412000000_coach_message_current_thread. Only for a confirmed
-- defect: it lets a coach read and write a moved client's old thread again
-- through direct table access.

SET lock_timeout = '5s';

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

RESET lock_timeout;
