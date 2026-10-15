-- RLSDIAG (RLSINV H08, owner "RLS for everything!"): a DiagnosticSubmission
-- row written through row security needs a signed-in owner. TIGHTENING ONLY:
-- one policy's WITH CHECK and its comment. No data change, no grant change.
--
-- GAP: p_diagnosticsubmission_insert (20261213000000, INSERT, TO public)
--   admitted any row with user_id NULL, with no identity at all. anon and
--   authenticated hold full table grants, so a signed-in user's JWT on the
--   Supabase Data API (app.current_user_id() is NULL there) could insert
--   unlimited user_id-NULL rows, skipping the server's validation and rate
--   limit. Write-only (no row comes back), but reachable today. The anon key
--   already errors: EXECUTE on app.is_owner() is revoked from anon.
--
-- NOW: the owner, or a caller whose app.current_user_id() is the row's
--   user_id. Anonymous rows are written only by the server: Prisma connects
--   as service_role (BYPASSRLS, plus p_diagnosticsubmission_service_role_all).
--   SELECT, UPDATE and DELETE are unchanged.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER POLICY "p_diagnosticsubmission_insert" ON "DiagnosticSubmission"
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())));
COMMENT ON POLICY "p_diagnosticsubmission_insert" ON "DiagnosticSubmission" IS '20270501000000: owner, or the signed-in user for a row attributed to themself. Anonymous rows (user_id NULL) are written only by the server as service_role.';

COMMIT;
