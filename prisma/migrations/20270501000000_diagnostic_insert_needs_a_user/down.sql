-- Reverse of 20270501000000_diagnostic_insert_needs_a_user. Only for a
-- confirmed defect: any signed-in user can again insert user_id-NULL
-- DiagnosticSubmission rows straight through the Data API. Restores the
-- 20261213000000 policy text and comment verbatim.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER POLICY "p_diagnosticsubmission_insert" ON "DiagnosticSubmission"
  WITH CHECK ((app.is_owner() OR "user_id" IS NULL OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())));
COMMENT ON POLICY "p_diagnosticsubmission_insert" ON "DiagnosticSubmission" IS 'Allow anonymous lead-funnel intake (user_id NULL) plus self-attributed and owner inserts.';

COMMIT;
