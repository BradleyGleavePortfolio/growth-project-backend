-- Owner 4 (GAPS1): a coach reads and writes a coach-side row about a client
-- only while that client's coach_id is still the row's coach. After a move,
-- the old coach's thread, review marker, pin/mute row, accepted invite and
-- signup row of that client are former rows, and direct table access stops
-- returning them. The client keeps reading every message of their own
-- (nothing is deleted; HIST-4a read-only view) but writes only into the
-- current thread.
--
-- One helper carries the rule: app.is_user_coached_by(client, coach), the
-- existing SECURITY DEFINER function (20260607000000; fixed search_path,
-- granted to the API roles). A sub-coach writes as themselves under the
-- existing team helpers app.is_subcoach_of / app.is_subcoach_on_coach_team
-- (20261215000000): an open delegation for that client, on that coach's team.
-- That also closes the old sender branch, which let any signed-in user write
-- into any thread by naming themselves as sender_id.
--
-- No longer readable through RLS: a coach's view of rows whose client account
-- was deleted (client_id NULL), and an owner's or former teammate's own sent
-- lines. The server reads through Prisma's service-role connection, which
-- bypasses RLS, so no app path changes. RLS stays enabled and forced on every
-- table here. Reverse: down.sql.

SET lock_timeout = '5s';

-- CoachMessage: every command needs the current thread and one of its people.
ALTER POLICY "coach_message_participant_access" ON "CoachMessage"
  USING (
    app.current_user_id() IS NOT NULL
    AND app.is_user_coached_by("client_id", "coach_id")
    AND (
      "client_id" = app.current_user_id()
      OR "coach_id" = app.current_user_id()
      OR (
        "sender_id" = app.current_user_id()
        AND app.is_subcoach_of("client_id")
        AND app.is_subcoach_on_coach_team("coach_id")
      )
    )
  )
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND app.is_user_coached_by("client_id", "coach_id")
    AND (
      "client_id" = app.current_user_id()
      OR "coach_id" = app.current_user_id()
      OR (
        "sender_id" = app.current_user_id()
        AND app.is_subcoach_of("client_id")
        AND app.is_subcoach_on_coach_team("coach_id")
      )
    )
  );

-- The client's read-only history: every row of their own, any thread.
CREATE POLICY "coach_message_client_history_read" ON "CoachMessage"
  FOR SELECT TO public
  USING (app.current_user_id() IS NOT NULL AND "client_id" = app.current_user_id());

-- ConversationReview (coach_id is the thread's coach): the client as before.
ALTER POLICY "conversation_review_participant_access" ON "ConversationReview"
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

-- CoachThreadState (one person's pin/mute of a thread): the client as before.
ALTER POLICY "coach_thread_state_self_access" ON "CoachThreadState"
  USING (
    app.current_user_id() IS NOT NULL
    AND "user_id" = app.current_user_id()
    AND ("client_id" = app.current_user_id() OR app.is_user_coached_by("client_id", "coach_id"))
  )
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND "user_id" = app.current_user_id()
    AND (
      "client_id" = app.current_user_id()
      OR ("coach_id" = app.current_user_id() AND app.is_user_coached_by("client_id", "coach_id"))
    )
  );

-- InviteCode: a pending code as before; an accepted one while its client stays.
ALTER POLICY "invite_code_coach_owner_access" ON "InviteCode"
  USING (
    app.current_user_id() IS NOT NULL
    AND ("coach_id" = app.current_user_id() OR "invited_by_user_id" = app.current_user_id())
    AND ("accepted_by_user_id" IS NULL OR app.is_user_coached_by("accepted_by_user_id", "coach_id"))
  )
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND ("coach_id" = app.current_user_id() OR "invited_by_user_id" = app.current_user_id())
    AND ("accepted_by_user_id" IS NULL OR app.is_user_coached_by("accepted_by_user_id", "coach_id"))
  );

-- InviteRedemption (read-only ledger): the owner as before.
ALTER POLICY "p_inviteredemption_select" ON "InviteRedemption"
  USING (
    app.is_owner()
    OR (
      app.current_user_id() IS NOT NULL
      AND "coach_id" = app.current_user_id()
      AND app.is_user_coached_by("client_user_id", "coach_id")
    )
  );

RESET lock_timeout;
