-- RLSLIVE2b (RLSINV P01): at the row layer a client books sessions only with
-- their own coach, asks rather than confirms, and never writes the coach's
-- side of a session. TIGHTENING ONLY: two helpers, a trigger, the client
-- branch of two policies. No data change.
--
-- GAP (20270413000000, #972): the client branch of p_coachingsession_insert
-- and p_coachingsession_update pinned only client_id. A client could create a
-- confirmed session naming any coach, and update every column of their own
-- sessions, coach_notes_md, video_url, video_meeting_id, calendar_event_id,
-- provider_idempotency_key, coach_id and status included. #972 hid those
-- columns from reads, but the table UPDATE grant still covers them, and a
-- column grant cannot split coach from client: both use the authenticated role.
--
-- NOW (the rules of scheduling.permissions.ts and requestSession):
--   * the client branch needs the session's coach to be the client's coach
--     (app.is_user_coached_by(client_id, coach_id)), for INSERT and for UPDATE
--     before and after the change. Owner and coach branches are #972's text.
--   * a client creates a session only as 'requested', or as 'scheduled' when
--     its type is one of that coach's live instant-confirm (auto_approve)
--     types: the two statuses requestSession writes.
--   * BEFORE UPDATE trigger: only the session's coach (app.current_user_id()
--     = OLD.coach_id) or a role that bypasses row security (service_role,
--     postgres) changes coach_notes_md, video_url, video_meeting_id,
--     calendar_event_id, provider_idempotency_key, coach_id or status. The
--     client keeps the two status changes the server makes for them: cancel
--     (requested, scheduled or pending_provider -> canceled) and a move that
--     asks the coach again (scheduled -> requested).
-- The backend connects with credentials that bypass RLS, so every server flow
-- (request, confirm, decline, move, cancel, call link, calendar sync, expiry)
-- is unchanged; the app reads no table directly. Reverse: down.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION app.session_type_auto_approves(session_type_id text, coach_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public."SessionType" t
    WHERE t."id" = session_type_id
      AND t."coach_id" = coach_user_id
      AND t."auto_approve"
      AND t."archived_at" IS NULL
  )
$$;
COMMENT ON FUNCTION app.session_type_auto_approves(text, text) IS
  'RLS helper (20270502000400): true when the session type is a live instant-confirm (auto_approve) type of that coach. Called by p_coachingsession_insert.';
REVOKE ALL ON FUNCTION app.session_type_auto_approves(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.session_type_auto_approves(text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION app.coaching_session_private_columns_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF app.current_user_id() = OLD."coach_id"
     OR (SELECT r."rolbypassrls" OR r."rolsuper" FROM pg_catalog.pg_roles r WHERE r."rolname" = current_user) THEN
    RETURN NEW;
  END IF;
  IF NEW."coach_notes_md" IS DISTINCT FROM OLD."coach_notes_md"
     OR NEW."video_url" IS DISTINCT FROM OLD."video_url"
     OR NEW."video_meeting_id" IS DISTINCT FROM OLD."video_meeting_id"
     OR NEW."calendar_event_id" IS DISTINCT FROM OLD."calendar_event_id"
     OR NEW."provider_idempotency_key" IS DISTINCT FROM OLD."provider_idempotency_key"
     OR NEW."coach_id" IS DISTINCT FROM OLD."coach_id"
     OR (NEW."status" IS DISTINCT FROM OLD."status"
         AND NOT (NEW."status" = 'canceled' AND OLD."status" IN ('requested', 'scheduled', 'pending_provider'))
         AND NOT (NEW."status" = 'requested' AND OLD."status" = 'scheduled')) THEN
    RAISE EXCEPTION 'coaching_session_private_columns_guard: only the session coach changes this column'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.coaching_session_private_columns_guard() IS
  'BEFORE UPDATE guard on CoachingSession (20270502000400): only the session coach or a role that bypasses row security changes coach_notes_md, video_url, video_meeting_id, calendar_event_id, provider_idempotency_key, coach_id or status; anyone else may only cancel or move a confirmed session back to requested.';
REVOKE ALL ON FUNCTION app.coaching_session_private_columns_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS "coaching_session_private_columns_guard" ON "CoachingSession";
CREATE TRIGGER "coaching_session_private_columns_guard"
  BEFORE UPDATE ON "CoachingSession"
  FOR EACH ROW EXECUTE FUNCTION app.coaching_session_private_columns_guard();

ALTER POLICY "p_coachingsession_insert" ON "CoachingSession"
  WITH CHECK (app.is_owner() OR (app.current_user_id() IS NOT NULL AND (("client_id" = app.current_user_id() AND app.is_user_coached_by("client_id", "coach_id") AND ("status" = 'requested' OR ("status" = 'scheduled' AND app.session_type_auto_approves("session_type_id", "coach_id")))) OR ("coach_id" = app.current_user_id() AND ("client_id" IS NULL OR app.client_still_books_caller("client_id"))))));
ALTER POLICY "p_coachingsession_update" ON "CoachingSession"
  USING (app.is_owner() OR (app.current_user_id() IS NOT NULL AND (("client_id" = app.current_user_id() AND app.is_user_coached_by("client_id", "coach_id")) OR ("coach_id" = app.current_user_id() AND ("client_id" IS NULL OR app.client_still_books_caller("client_id"))))))
  WITH CHECK (app.is_owner() OR (app.current_user_id() IS NOT NULL AND (("client_id" = app.current_user_id() AND app.is_user_coached_by("client_id", "coach_id")) OR ("coach_id" = app.current_user_id() AND ("client_id" IS NULL OR app.client_still_books_caller("client_id"))))));
COMMENT ON POLICY "p_coachingsession_insert" ON "CoachingSession" IS '20270502000400: owner; the lead client with their own coach, as requested (scheduled only for that coach''s instant-confirm type); or the session coach while the client may still book with them (no client: always) may create the session.';
COMMENT ON POLICY "p_coachingsession_update" ON "CoachingSession" IS '20270502000400: owner, the lead client with their own coach, or the session coach while the client may still book with them (no client: always) may update the session, before and after the change. Coach-side columns: coaching_session_private_columns_guard.';

COMMIT;
