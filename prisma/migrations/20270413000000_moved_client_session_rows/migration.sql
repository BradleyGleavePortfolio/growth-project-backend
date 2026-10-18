-- CoachingSession: a moved client's sessions leave the old coach in the row
-- policies too (owner 4, HIST-2b). TIGHTENING ONLY: one helper, the four
-- "p_coachingsession_*" policies rewritten, coach-only columns kept from the
-- API roles. No data change.
--
-- GAP (20261213000000_rls_tier2_sessions): every policy admitted the session's
-- coach_id with no end, and the client's current coach on every session with
-- that client. After a move the old coach still read and wrote the sessions
-- with the moved client, and the new coach read the old coach's rows,
-- coach_notes_md included. The client read coach-only columns the API masks.
--
-- NOW, for SELECT, INSERT, UPDATE and DELETE alike:
--   * owners, as before;
--   * the lead client (client_id = caller), as before, so their history stays;
--   * the session's coach while the client may still book with them, the rule
--     of SchedulingAccessService.bookableCoachIds: the client's coach_id is the
--     caller, or the caller is the sub-coach of the client's latest open
--     delegation under that coach, with a live team seat. A session with no
--     client stays the coach's.
--   The client's-current-coach branch is gone: a coach reaches only sessions
--   they run. SessionParticipant reaches sessions through CoachingSession, so
--   it follows. The API roles may SELECT only the columns every participant
--   sees through the API; coach_notes_md, video_url, video_meeting_id,
--   calendar_event_id and provider_idempotency_key are read by the backend only.
-- The backend uses Prisma credentials that bypass RLS and the app reads no
-- table directly, so no app path changes. Reverse: down.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION app.client_still_books_caller(client_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public."User" client
    WHERE client."id" = client_user_id
      AND client."role" = 'student'
      AND (
        client."coach_id" = app.current_user_id()
        OR (
          (SELECT d."sub_coach_id"
             FROM public."SubCoachAssignment" d
            WHERE d."client_id" = client."id"
              AND d."head_coach_id" = client."coach_id"
              AND d."unassigned_at" IS NULL
            ORDER BY d."assigned_at" DESC
            LIMIT 1) = app.current_user_id()
          AND EXISTS (
            SELECT 1
            FROM public."TeamSubCoachAssignment" seat
            WHERE seat."head_coach_id" = client."coach_id"
              AND seat."sub_coach_id" = app.current_user_id()
              AND seat."archived_at" IS NULL
          )
        )
      )
  )
$$;
COMMENT ON FUNCTION app.client_still_books_caller(text) IS
  'Caller-bound RLS helper (20270413000000): true when the student client may still book with app.current_user_id(), as SchedulingAccessService.bookableCoachIds decides. Called by the p_coachingsession_* policies.';
REVOKE ALL ON FUNCTION app.client_still_books_caller(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.client_still_books_caller(text) TO anon, authenticated, service_role;

ALTER POLICY "p_coachingsession_select" ON "CoachingSession"
  USING (app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR ("coach_id" = app.current_user_id() AND ("client_id" IS NULL OR app.client_still_books_caller("client_id"))))));
ALTER POLICY "p_coachingsession_insert" ON "CoachingSession"
  WITH CHECK (app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR ("coach_id" = app.current_user_id() AND ("client_id" IS NULL OR app.client_still_books_caller("client_id"))))));
ALTER POLICY "p_coachingsession_update" ON "CoachingSession"
  USING (app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR ("coach_id" = app.current_user_id() AND ("client_id" IS NULL OR app.client_still_books_caller("client_id"))))))
  WITH CHECK (app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR ("coach_id" = app.current_user_id() AND ("client_id" IS NULL OR app.client_still_books_caller("client_id"))))));
ALTER POLICY "p_coachingsession_delete" ON "CoachingSession"
  USING (app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR ("coach_id" = app.current_user_id() AND ("client_id" IS NULL OR app.client_still_books_caller("client_id"))))));
COMMENT ON POLICY "p_coachingsession_select" ON "CoachingSession" IS '20270413000000: owner, the lead client, or the session coach while the client may still book with them (no client: always) may read the session.';
COMMENT ON POLICY "p_coachingsession_insert" ON "CoachingSession" IS '20270413000000: owner, the lead client, or the session coach while the client may still book with them (no client: always) may create the session.';
COMMENT ON POLICY "p_coachingsession_update" ON "CoachingSession" IS '20270413000000: owner, the lead client, or the session coach while the client may still book with them (no client: always) may update the session, before and after the change.';
COMMENT ON POLICY "p_coachingsession_delete" ON "CoachingSession" IS '20270413000000: owner, the lead client, or the session coach while the client may still book with them (no client: always) may delete the session.';

REVOKE SELECT ON "CoachingSession" FROM anon, authenticated;
GRANT SELECT ("id", "coach_id", "client_id", "session_type_id", "status", "start_at", "end_at",
  "title", "client_recap_md", "video_provider", "calendar_provider", "approved_at", "ended_at",
  "end_reason", "request_expires_at", "created_at", "updated_at") ON "CoachingSession" TO authenticated;

COMMIT;
