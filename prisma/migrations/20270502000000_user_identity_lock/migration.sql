-- RLSIDENT (RLSINV I01, I02; owner "RLS for everything!"): at the row layer a
-- user can no longer rewrite their own role, coach link or login id, or
-- delete their own account row; a client and their current coach can read
-- each other's row. Metadata only: policies, column grants, two helpers. No
-- data change, no table rewrite.
--
-- GAP: "User".user_self_access (FOR ALL TO public, id = app.current_user_id()
--   in USING and WITH CHECK, 20270410000000) let a user UPDATE every column of
--   their own row (role -> owner opens every app.is_owner() branch; coach_id ->
--   any coach makes them that coach's client for app.is_current_coach_of;
--   supabase_id -> another login id, which the auth.uid() policies resolve
--   through) and DELETE it (skipping the deletion workflow). anon and
--   authenticated held table-wide UPDATE (Supabase default privileges). The
--   coach could not read a client's row and the client not their coach's.
--
-- NOW:
--   user_self_select   SELECT  own row                 (TO public, as before)
--   user_self_update   UPDATE  own row, USING + CHECK  (TO public, as before)
--   user_current_coach_reads_client   SELECT  rows of the caller's current
--                      clients: app.caller_coaches_user(id)
--   user_client_reads_current_coach   SELECT  the caller's current coach:
--                      id = app.caller_current_coach_id()
--   No INSERT or DELETE policy: both are server-only (service_role).
--   UPDATE is column-granted to authenticated on name, phone,
--   leaderboard_display_name and show_on_leaderboard only; anon holds none.
--   Every branch keys on app.current_user_id() only, never auth.uid() or
--   request.jwt.claims (RLSINV I04): a Data API JWT resolves to NULL here, so
--   "User" and the seven auth.uid() workout policies that sub-select it stay
--   closed on the Data API. A former coach reads nothing: both helpers follow
--   User.coach_id, which a move rewrites.
--
-- HELPERS: SECURITY DEFINER, owned by postgres (bypasses row security), so a
--   policy on "User" never evaluates "User" policies again (no recursion).
--   Same client rule as app.is_user_coached_by: role student, coach_id = coach.
--
-- REACH TODAY: none. The server connects as service_role (BYPASSRLS) and never
--   sets app.current_user_id; the mobile app reads no table directly.
-- ROLLBACK: down.sql restores user_self_access and the table-wide UPDATE grant
--   exactly, and drops both helpers.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION app.caller_coaches_user(target_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT app.current_user_id() IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public."User" u
       WHERE u."id" = target_user_id
         AND u."coach_id" = app.current_user_id()
         AND u."role" = 'student'
     )
$$;

CREATE OR REPLACE FUNCTION app.caller_current_coach_id()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT u."coach_id" FROM public."User" u
  WHERE u."id" = app.current_user_id() AND u."role" = 'student'
$$;

ALTER FUNCTION app.caller_coaches_user(text) OWNER TO postgres;
ALTER FUNCTION app.caller_current_coach_id() OWNER TO postgres;
REVOKE ALL ON FUNCTION app.caller_coaches_user(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.caller_current_coach_id() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.caller_coaches_user(text) FROM anon;
REVOKE EXECUTE ON FUNCTION app.caller_current_coach_id() FROM anon;
GRANT EXECUTE ON FUNCTION app.caller_coaches_user(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.caller_current_coach_id() TO authenticated, service_role;
COMMENT ON FUNCTION app.caller_coaches_user(text) IS
  '20270502000000: true when the supplied User.id is a student whose coach_id is app.current_user_id(). SECURITY DEFINER so "User" policies never recurse. Keys on app.current_user_id() only.';
COMMENT ON FUNCTION app.caller_current_coach_id() IS
  '20270502000000: coach_id of the calling student (app.current_user_id()), else NULL. SECURITY DEFINER so "User" policies never recurse. Keys on app.current_user_id() only.';

DROP POLICY IF EXISTS "user_self_access" ON public."User";

CREATE POLICY "user_self_select" ON public."User"
  AS PERMISSIVE FOR SELECT TO public
  USING ("id" = app.current_user_id());
CREATE POLICY "user_self_update" ON public."User"
  AS PERMISSIVE FOR UPDATE TO public
  USING ("id" = app.current_user_id())
  WITH CHECK ("id" = app.current_user_id());
CREATE POLICY "user_current_coach_reads_client" ON public."User"
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (app.caller_coaches_user("id"));
CREATE POLICY "user_client_reads_current_coach" ON public."User"
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ("id" = app.caller_current_coach_id());

COMMENT ON POLICY "user_self_select" ON public."User" IS
  '20270502000000: a user reads their own row (app.current_user_id()).';
COMMENT ON POLICY "user_self_update" ON public."User" IS
  '20270502000000: a user updates their own row, only in the columns granted to authenticated (name, phone, leaderboard_display_name, show_on_leaderboard). No INSERT or DELETE policy: server only.';
COMMENT ON POLICY "user_current_coach_reads_client" ON public."User" IS
  '20270502000000: a coach reads the rows of their current clients (app.caller_coaches_user). A former coach reads nothing.';
COMMENT ON POLICY "user_client_reads_current_coach" ON public."User" IS
  '20270502000000: a client reads their current coach''s row (app.caller_current_coach_id).';

-- REVOKE on the table also clears any column-level UPDATE grant.
REVOKE UPDATE ON public."User" FROM anon, authenticated;
GRANT UPDATE ("name", "phone", "leaderboard_display_name", "show_on_leaderboard") ON public."User" TO authenticated;

COMMIT;
