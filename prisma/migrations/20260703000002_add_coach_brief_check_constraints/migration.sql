-- P2-4: DB-layer validation for the Coach Brief tables. DTOs already
-- reject bad input at the HTTP boundary, but the migration accepts
-- arbitrary TEXT for status, brief_date, generated_by, brief_mode,
-- notification_time, timezone, and unbounded content. CHECK constraints
-- here are the second layer so a backend bug or a future direct-RLS path
-- cannot persist corrupted rows.

-- ────────────────────────────────────────────────────────────────────────────
-- CoachBrief
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE "CoachBrief"
  DROP CONSTRAINT IF EXISTS "CoachBrief_status_check",
  ADD  CONSTRAINT "CoachBrief_status_check"
  CHECK ("status" IN ('pending', 'generating', 'generated', 'failed'));

ALTER TABLE "CoachBrief"
  DROP CONSTRAINT IF EXISTS "CoachBrief_brief_date_format_check",
  ADD  CONSTRAINT "CoachBrief_brief_date_format_check"
  CHECK ("brief_date" ~ '^\d{4}-\d{2}-\d{2}$');

ALTER TABLE "CoachBrief"
  DROP CONSTRAINT IF EXISTS "CoachBrief_generated_by_check",
  ADD  CONSTRAINT "CoachBrief_generated_by_check"
  CHECK ("generated_by" IS NULL OR "generated_by" IN ('ai', 'fallback'));

ALTER TABLE "CoachBrief"
  DROP CONSTRAINT IF EXISTS "CoachBrief_brief_mode_check",
  ADD  CONSTRAINT "CoachBrief_brief_mode_check"
  CHECK ("brief_mode" IS NULL OR "brief_mode" IN ('solo_coach', 'head_coach', 'sub_coach'));

-- Narrative is capped at the same MAX as the application (600 chars) so
-- a malformed write can't blow past the mobile UI budget.
ALTER TABLE "CoachBrief"
  DROP CONSTRAINT IF EXISTS "CoachBrief_narrative_length_check",
  ADD  CONSTRAINT "CoachBrief_narrative_length_check"
  CHECK ("narrative" IS NULL OR char_length("narrative") <= 600);

-- ────────────────────────────────────────────────────────────────────────────
-- CoachDailyLog
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE "CoachDailyLog"
  DROP CONSTRAINT IF EXISTS "CoachDailyLog_log_date_format_check",
  ADD  CONSTRAINT "CoachDailyLog_log_date_format_check"
  CHECK ("log_date" ~ '^\d{4}-\d{2}-\d{2}$');

-- DTO caps content at 4000 chars; mirror at the DB layer.
ALTER TABLE "CoachDailyLog"
  DROP CONSTRAINT IF EXISTS "CoachDailyLog_content_length_check",
  ADD  CONSTRAINT "CoachDailyLog_content_length_check"
  CHECK (char_length("content") <= 4000);

-- ────────────────────────────────────────────────────────────────────────────
-- CoachBriefPreferences
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE "CoachBriefPreferences"
  DROP CONSTRAINT IF EXISTS "CoachBriefPreferences_notification_time_check",
  ADD  CONSTRAINT "CoachBriefPreferences_notification_time_check"
  CHECK ("notification_time" ~ '^([01]\d|2[0-3]):[0-5]\d$');

-- IANA timezone strings are ~64 chars at most ("America/Argentina/Buenos_Aires"
-- is the longest in production use at 30); 80 is a comfortable ceiling
-- that still blocks runaway writes.
ALTER TABLE "CoachBriefPreferences"
  DROP CONSTRAINT IF EXISTS "CoachBriefPreferences_timezone_length_check",
  ADD  CONSTRAINT "CoachBriefPreferences_timezone_length_check"
  CHECK (char_length("timezone") BETWEEN 1 AND 80);

-- ROLLBACK:
-- ALTER TABLE "CoachBriefPreferences" DROP CONSTRAINT IF EXISTS "CoachBriefPreferences_timezone_length_check";
-- ALTER TABLE "CoachBriefPreferences" DROP CONSTRAINT IF EXISTS "CoachBriefPreferences_notification_time_check";
-- ALTER TABLE "CoachDailyLog"         DROP CONSTRAINT IF EXISTS "CoachDailyLog_content_length_check";
-- ALTER TABLE "CoachDailyLog"         DROP CONSTRAINT IF EXISTS "CoachDailyLog_log_date_format_check";
-- ALTER TABLE "CoachBrief"            DROP CONSTRAINT IF EXISTS "CoachBrief_narrative_length_check";
-- ALTER TABLE "CoachBrief"            DROP CONSTRAINT IF EXISTS "CoachBrief_brief_mode_check";
-- ALTER TABLE "CoachBrief"            DROP CONSTRAINT IF EXISTS "CoachBrief_generated_by_check";
-- ALTER TABLE "CoachBrief"            DROP CONSTRAINT IF EXISTS "CoachBrief_brief_date_format_check";
-- ALTER TABLE "CoachBrief"            DROP CONSTRAINT IF EXISTS "CoachBrief_status_check";
