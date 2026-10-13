-- READTESTS (decision 141-5, owner 4): a coach reads and writes a client's
-- macro targets only while that client's coach_id is still the row's coach.
-- macro_target_coach_all (20260607000000) checked only the author column, so
-- after a move the former coach still passed it for every target they wrote
-- (test/rls/coach-home-reads-rls.spec.ts, "the former coach reads none of the
-- client's rows").
--
-- Same rule and helper as GAPS1 (20270412000000):
-- app.is_user_coached_by(client, coach), the existing SECURITY DEFINER
-- function (20260607000000; fixed search_path, granted to the API roles). The
-- client's own read (macro_target_client_select) and the owner policy are
-- unchanged. The server reads through Prisma's service-role connection, which
-- bypasses RLS, and its route already answers a former coach 404
-- (MacrosService.assertClientOfCoach), so no app path changes. RLS stays
-- enabled and forced. Reverse: down.sql.

SET lock_timeout = '5s';

ALTER POLICY "macro_target_coach_all" ON "MacroTarget"
  USING (
    app.current_user_id() IS NOT NULL
    AND "coach_id" = app.current_user_id()
    AND app.is_user_coached_by("client_id", "coach_id")
  )
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND "coach_id" = app.current_user_id()
    AND app.is_user_coached_by("client_id", "coach_id")
  );

RESET lock_timeout;
