-- Reverse of 20270502000000_user_identity_lock. Only for a confirmed defect:
-- every user can again rewrite every column of their own "User" row (role,
-- coach_id, supabase_id) and delete it, and coach and client lose each other's
-- row. Restores the state before it exactly: user_self_access (FOR ALL TO
-- public, the 20270410000000 text, no comment), table-wide UPDATE for anon and
-- authenticated (the Supabase default grant), and no caller_* User helpers.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP POLICY IF EXISTS "user_client_reads_current_coach" ON public."User";
DROP POLICY IF EXISTS "user_current_coach_reads_client" ON public."User";
DROP POLICY IF EXISTS "user_self_update" ON public."User";
DROP POLICY IF EXISTS "user_self_select" ON public."User";
CREATE POLICY "user_self_access" ON public."User"
  FOR ALL TO public
  USING ("id" = app.current_user_id())
  WITH CHECK ("id" = app.current_user_id());

-- REVOKE on the table clears the column grant; then the table-wide grant returns.
REVOKE UPDATE ON public."User" FROM anon, authenticated;
GRANT UPDATE ON public."User" TO anon, authenticated;

DROP FUNCTION IF EXISTS app.caller_current_coach_id();
DROP FUNCTION IF EXISTS app.caller_coaches_user(text);

COMMIT;
