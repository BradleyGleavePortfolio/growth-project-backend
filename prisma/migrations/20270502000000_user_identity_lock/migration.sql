-- RLSIDENT (RLSINV I01, I02; owner "RLS for everything!"): at the row layer a
-- user can no longer rewrite their own role, coach link or login id, or
-- delete their own account row; a client and their current coach can read
-- each other's row. Metadata only: policies and column grants, no new
-- function. No data change, no table rewrite.
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
--                      clients: app.is_current_coach_of(id), the existing rule
--   user_client_reads_current_coach   SELECT  the caller's current coach:
--                      app.is_user_coached_by(app.current_user_id(), id)
--   No INSERT or DELETE policy: both are server-only (service_role).
--   UPDATE is column-granted to authenticated on name, phone,
--   leaderboard_display_name and show_on_leaderboard only; anon holds none.
--   Every branch keys on app.current_user_id() only, never auth.uid() or
--   request.jwt.claims (RLSINV I04): a Data API JWT resolves to NULL here, so
--   "User" and the seven auth.uid() workout policies that sub-select it stay
--   closed on the Data API. A former coach reads nothing: both branches follow
--   User.coach_id, which a move rewrites.
--
-- NO RECURSION: both read branches reach "User" only through the existing
--   app.is_user_coached_by (app.is_current_coach_of calls it and reads no
--   table itself), which is SECURITY DEFINER, owned by postgres (bypasses row
--   security), so a policy on "User" never evaluates "User" policies again.
--
-- REACH TODAY: none. The server connects as service_role (BYPASSRLS) and never
--   sets app.current_user_id; the mobile app reads no table directly.
-- ROLLBACK: down.sql restores user_self_access and the table-wide UPDATE grant
--   exactly.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

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
  USING (app.is_current_coach_of("id"));
CREATE POLICY "user_client_reads_current_coach" ON public."User"
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (app.is_user_coached_by(app.current_user_id(), "id"));

COMMENT ON POLICY "user_self_select" ON public."User" IS
  '20270502000000: a user reads their own row (app.current_user_id()).';
COMMENT ON POLICY "user_self_update" ON public."User" IS
  '20270502000000: a user updates their own row, only in the columns granted to authenticated (name, phone, leaderboard_display_name, show_on_leaderboard). No INSERT or DELETE policy: server only.';
COMMENT ON POLICY "user_current_coach_reads_client" ON public."User" IS
  '20270502000000: a coach reads the rows of their current clients (app.is_current_coach_of). A former coach reads nothing.';
COMMENT ON POLICY "user_client_reads_current_coach" ON public."User" IS
  '20270502000000: a client reads their current coach''s row (app.is_user_coached_by(app.current_user_id(), id)).';

-- REVOKE on the table also clears any column-level UPDATE grant.
REVOKE UPDATE ON public."User" FROM anon, authenticated;
GRANT UPDATE ("name", "phone", "leaderboard_display_name", "show_on_leaderboard") ON public."User" TO authenticated;

-- A REVOKE by a role that did not make the grant only warns: fail closed if
-- table-wide UPDATE survived it (column grants do not count here).
DO $$ BEGIN
  IF has_table_privilege('authenticated', 'public."User"', 'UPDATE')
     OR has_table_privilege('anon', 'public."User"', 'UPDATE')
  THEN RAISE EXCEPTION '20270502000000: table-wide UPDATE on "User" survived the REVOKE'; END IF; END $$;

COMMIT;
