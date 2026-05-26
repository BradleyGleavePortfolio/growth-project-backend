-- Partial unique index: at most one non-terminal DataExportRequest per user.
-- Closes A1-C5-P1-2 (JS-only rate-limit race in requestExport).
CREATE UNIQUE INDEX IF NOT EXISTS data_export_request_one_active_per_user
  ON "data_export_request" ("user_id")
  WHERE status IN ('PENDING', 'RUNNING', 'READY');
