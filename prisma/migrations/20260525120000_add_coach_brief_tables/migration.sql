-- R43 Coach Brief — adds 3 new tables (CoachBrief, CoachDailyLog,
-- CoachBriefPreferences) plus an `approved_by_coach_at` column on
-- ClientWorkoutAssignment so the brief can count "workouts pending
-- coach approval" without an extra join. All three new tables get
-- ENABLE + FORCE row-level security with explicit policies that:
--   * Bypass for the Supabase service role (the NestJS backend).
--   * Restrict the coach-side direct client (if/when wired) to their
--     own rows via the app.current_user_id() RLS helper.
-- Brief generation is server-only (CoachBrief has no INSERT/UPDATE
-- policy for coaches); the daily log and preferences allow coach
-- INSERT and UPDATE on rows scoped to the calling user.

-- ────────────────────────────────────────────────────────────────────────────
-- ClientWorkoutAssignment.approved_by_coach_at
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE "ClientWorkoutAssignment"
  ADD COLUMN IF NOT EXISTS "approved_by_coach_at" TIMESTAMP(3);

-- NOTE: The supporting index on
--   ("assigned_by_coach_id", "approved_by_coach_at")
-- is created in a follow-up migration
--   20260704000001_coach_brief_cwa_index_concurrent
-- that runs OUTSIDE the default Prisma transaction so it can use
-- CREATE INDEX CONCURRENTLY. ClientWorkoutAssignment is a hot,
-- populated table; a non-concurrent CREATE INDEX would take an
-- ACCESS EXCLUSIVE lock and block writes for the duration of the
-- index build. See that migration's header for details.

-- ────────────────────────────────────────────────────────────────────────────
-- CoachBrief
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "CoachBrief" (
  "id"            TEXT NOT NULL,
  "coach_id"      TEXT NOT NULL,
  "brief_date"    TEXT NOT NULL,
  "status"        TEXT NOT NULL DEFAULT 'pending',
  "generated_at"  TIMESTAMP(3),
  "narrative"     TEXT,
  "brief_context" JSONB,
  "action_items"  JSONB,
  "generated_by"  TEXT,
  "brief_mode"    TEXT,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CoachBrief_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CoachBrief_coach_date_key"
  ON "CoachBrief" ("coach_id", "brief_date");
CREATE INDEX IF NOT EXISTS "CoachBrief_coach_id_brief_date_idx"
  ON "CoachBrief" ("coach_id", "brief_date");
CREATE INDEX IF NOT EXISTS "CoachBrief_coach_id_status_idx"
  ON "CoachBrief" ("coach_id", "status");

ALTER TABLE "CoachBrief"
  ADD CONSTRAINT "CoachBrief_coach_id_fkey"
  FOREIGN KEY ("coach_id") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CoachBrief" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachBrief" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "coach_brief_service_role_bypass" ON "CoachBrief";
CREATE POLICY "coach_brief_service_role_bypass"
  ON "CoachBrief"
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Coach-side direct read of their own brief. Writes stay server-only.
DROP POLICY IF EXISTS "coach_select_own_brief" ON "CoachBrief";
CREATE POLICY "coach_select_own_brief"
  ON "CoachBrief"
  FOR SELECT
  USING (
    app.current_user_id() IS NOT NULL
    AND "coach_id" = app.current_user_id()
  );

-- ────────────────────────────────────────────────────────────────────────────
-- CoachDailyLog
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "CoachDailyLog" (
  "id"         TEXT NOT NULL,
  "coach_id"   TEXT NOT NULL,
  "log_date"   TEXT NOT NULL,
  "content"    TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CoachDailyLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CoachDailyLog_coach_log_date_key"
  ON "CoachDailyLog" ("coach_id", "log_date");
CREATE INDEX IF NOT EXISTS "CoachDailyLog_coach_id_log_date_idx"
  ON "CoachDailyLog" ("coach_id", "log_date");

ALTER TABLE "CoachDailyLog"
  ADD CONSTRAINT "CoachDailyLog_coach_id_fkey"
  FOREIGN KEY ("coach_id") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CoachDailyLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachDailyLog" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "coach_daily_log_service_role_bypass" ON "CoachDailyLog";
CREATE POLICY "coach_daily_log_service_role_bypass"
  ON "CoachDailyLog"
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "coach_select_own_daily_log" ON "CoachDailyLog";
CREATE POLICY "coach_select_own_daily_log"
  ON "CoachDailyLog"
  FOR SELECT
  USING (
    app.current_user_id() IS NOT NULL
    AND "coach_id" = app.current_user_id()
  );

DROP POLICY IF EXISTS "coach_insert_own_daily_log" ON "CoachDailyLog";
CREATE POLICY "coach_insert_own_daily_log"
  ON "CoachDailyLog"
  FOR INSERT
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND "coach_id" = app.current_user_id()
  );

DROP POLICY IF EXISTS "coach_update_own_daily_log" ON "CoachDailyLog";
CREATE POLICY "coach_update_own_daily_log"
  ON "CoachDailyLog"
  FOR UPDATE
  USING (
    app.current_user_id() IS NOT NULL
    AND "coach_id" = app.current_user_id()
  )
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND "coach_id" = app.current_user_id()
  );

-- ────────────────────────────────────────────────────────────────────────────
-- CoachBriefPreferences
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "CoachBriefPreferences" (
  "id"                TEXT NOT NULL,
  "coach_id"          TEXT NOT NULL,
  "notification_time" TEXT NOT NULL DEFAULT '07:00',
  "timezone"          TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  "enabled"           BOOLEAN NOT NULL DEFAULT true,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CoachBriefPreferences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CoachBriefPreferences_coach_id_key"
  ON "CoachBriefPreferences" ("coach_id");
CREATE INDEX IF NOT EXISTS "CoachBriefPreferences_enabled_notification_time_idx"
  ON "CoachBriefPreferences" ("enabled", "notification_time");

ALTER TABLE "CoachBriefPreferences"
  ADD CONSTRAINT "CoachBriefPreferences_coach_id_fkey"
  FOREIGN KEY ("coach_id") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CoachBriefPreferences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachBriefPreferences" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "coach_brief_prefs_service_role_bypass" ON "CoachBriefPreferences";
CREATE POLICY "coach_brief_prefs_service_role_bypass"
  ON "CoachBriefPreferences"
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "coach_select_own_brief_prefs" ON "CoachBriefPreferences";
CREATE POLICY "coach_select_own_brief_prefs"
  ON "CoachBriefPreferences"
  FOR SELECT
  USING (
    app.current_user_id() IS NOT NULL
    AND "coach_id" = app.current_user_id()
  );

DROP POLICY IF EXISTS "coach_insert_own_brief_prefs" ON "CoachBriefPreferences";
CREATE POLICY "coach_insert_own_brief_prefs"
  ON "CoachBriefPreferences"
  FOR INSERT
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND "coach_id" = app.current_user_id()
  );

DROP POLICY IF EXISTS "coach_update_own_brief_prefs" ON "CoachBriefPreferences";
CREATE POLICY "coach_update_own_brief_prefs"
  ON "CoachBriefPreferences"
  FOR UPDATE
  USING (
    app.current_user_id() IS NOT NULL
    AND "coach_id" = app.current_user_id()
  )
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND "coach_id" = app.current_user_id()
  );

-- ROLLBACK:
-- Reverse dependency order — policies, then RLS, then FKs, then indexes,
-- then tables, finishing with the ClientWorkoutAssignment column.
-- DROP POLICY IF EXISTS "coach_update_own_brief_prefs"          ON "CoachBriefPreferences";
-- DROP POLICY IF EXISTS "coach_insert_own_brief_prefs"          ON "CoachBriefPreferences";
-- DROP POLICY IF EXISTS "coach_select_own_brief_prefs"          ON "CoachBriefPreferences";
-- DROP POLICY IF EXISTS "coach_brief_prefs_service_role_bypass" ON "CoachBriefPreferences";
-- ALTER TABLE "CoachBriefPreferences" DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS "coach_update_own_daily_log"            ON "CoachDailyLog";
-- DROP POLICY IF EXISTS "coach_insert_own_daily_log"            ON "CoachDailyLog";
-- DROP POLICY IF EXISTS "coach_select_own_daily_log"            ON "CoachDailyLog";
-- DROP POLICY IF EXISTS "coach_daily_log_service_role_bypass"   ON "CoachDailyLog";
-- ALTER TABLE "CoachDailyLog" DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS "coach_select_own_brief"                ON "CoachBrief";
-- DROP POLICY IF EXISTS "coach_brief_service_role_bypass"       ON "CoachBrief";
-- ALTER TABLE "CoachBrief" DISABLE ROW LEVEL SECURITY;
--
-- DROP INDEX IF EXISTS "CoachBriefPreferences_enabled_notification_time_idx";
-- DROP INDEX IF EXISTS "CoachBriefPreferences_coach_id_key";
-- DROP INDEX IF EXISTS "CoachDailyLog_coach_id_log_date_idx";
-- DROP INDEX IF EXISTS "CoachDailyLog_coach_log_date_key";
-- DROP INDEX IF EXISTS "CoachBrief_coach_id_status_idx";
-- DROP INDEX IF EXISTS "CoachBrief_coach_id_brief_date_idx";
-- DROP INDEX IF EXISTS "CoachBrief_coach_date_key";
--
-- DROP TABLE IF EXISTS "CoachBriefPreferences" CASCADE;
-- DROP TABLE IF EXISTS "CoachDailyLog"         CASCADE;
-- DROP TABLE IF EXISTS "CoachBrief"            CASCADE;
--
-- (Index drop is handled in the follow-up migration
--  20260704000001_coach_brief_cwa_index_concurrent rollback notes.)
-- ALTER TABLE "ClientWorkoutAssignment" DROP COLUMN IF EXISTS "approved_by_coach_at";
