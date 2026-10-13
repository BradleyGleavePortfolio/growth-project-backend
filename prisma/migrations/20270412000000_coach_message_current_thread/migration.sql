-- CoachMessage: a coach-side reader reads a thread only while its client is
-- still with the thread's coach (owner 4, GAPS1). A thread lives under the
-- client's own coach (MessagingService opens coach_id = the client's coach_id),
-- so after a move the old coach's thread is a former thread. The policy from
-- 20260607000000 (re-asserted by 20270303000000) admitted every row whose
-- coach_id or sender_id is the reader, so with direct table access the old
-- coach, or a teammate who wrote in that thread, kept reading the moved
-- client's chat.
--
-- Now the client reads and writes every row of their own, as before (nothing
-- is deleted; HIST-4a). The thread's coach, or a coach-side sender, does so
-- only while app.is_user_coached_by(client_id, coach_id) holds: the existing
-- SECURITY DEFINER helper (fixed search_path, granted in 20260607000000). A row
-- whose client account was deleted (client_id NULL) is no longer readable by a
-- coach here. The server uses Prisma, which bypasses RLS, so no app path
-- changes. RLS stays on and forced. Reverse: down.sql.

SET lock_timeout = '5s';

ALTER POLICY "coach_message_participant_access" ON "CoachMessage"
  USING (
    app.current_user_id() IS NOT NULL
    AND (
      "client_id" = app.current_user_id()
      OR (
        ("coach_id" = app.current_user_id() OR "sender_id" = app.current_user_id())
        AND app.is_user_coached_by("client_id", "coach_id")
      )
    )
  )
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND (
      "client_id" = app.current_user_id()
      OR (
        ("coach_id" = app.current_user_id() OR "sender_id" = app.current_user_id())
        AND app.is_user_coached_by("client_id", "coach_id")
      )
    )
  );

RESET lock_timeout;
