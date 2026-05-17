-- RLS defense-in-depth migration for growth-project-backend (fitness)
-- Prisma stores application UUIDs as TEXT in this schema, so policies compare
-- against app.current_user_id() as TEXT rather than casting to uuid.
-- Prisma's production connection uses Supabase service_role and therefore
-- bypasses RLS; these policies protect direct Studio/dashboard access and any
-- future anon/authenticated-key code path.
--
-- SAFE TO RE-RUN: all DROP POLICY IF EXISTS + CREATE SCHEMA/FUNCTION are idempotent.
-- TABLES EXCLUDED (not yet in production as of May 17 2026):
--   ExerciseCatalogItem (20260601), ConnectAccount (20260521),
--   ConnectCustomer / ClientPurchase / CoachPackage (20260601+)
-- HabitLog is excluded from direct policy — it has no user_id column; its
-- data is only accessible through the owning Habit row (which IS protected).

BEGIN;

-- 1) service_role already has BYPASSRLS on Supabase managed instances.
--    DO NOT run ALTER ROLE service_role — it's a reserved role and will fail
--    with 42501 on all managed Supabase projects.

-- Helper: returns NULL when no session variable is set.
-- NULL makes every USING predicate evaluate false (safe deny) instead of
-- raising an error. Set with: SET LOCAL app.current_user_id = '<User.id>';
CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.current_user_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')
$$;

COMMENT ON FUNCTION app.current_user_id() IS
  'Returns the NestJS-authenticated User.id stored in app.current_user_id for RLS policies; NULL means unauthenticated/no tenant context.';

-- 2) Enable and force RLS on every tenant-scoped table that exists in prod today.

ALTER TABLE "User"                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "User"                    FORCE ROW LEVEL SECURITY;

ALTER TABLE "UserProfile"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserProfile"             FORCE ROW LEVEL SECURITY;

ALTER TABLE "CoachSubscription"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachSubscription"       FORCE ROW LEVEL SECURITY;

ALTER TABLE "CoachMessage"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachMessage"            FORCE ROW LEVEL SECURITY;

ALTER TABLE "CheckIn"                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CheckIn"                 FORCE ROW LEVEL SECURITY;

ALTER TABLE "WeightLog"               ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WeightLog"               FORCE ROW LEVEL SECURITY;

ALTER TABLE "WorkoutSession"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkoutSession"          FORCE ROW LEVEL SECURITY;

ALTER TABLE "InviteCode"              ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InviteCode"              FORCE ROW LEVEL SECURITY;

ALTER TABLE "Notification"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Notification"            FORCE ROW LEVEL SECURITY;

ALTER TABLE "NotificationPreferences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NotificationPreferences" FORCE ROW LEVEL SECURITY;

ALTER TABLE "DataExportRequest"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DataExportRequest"       FORCE ROW LEVEL SECURITY;

ALTER TABLE "BloodworkPanel"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BloodworkPanel"          FORCE ROW LEVEL SECURITY;

ALTER TABLE "LoggedFoodEntry"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LoggedFoodEntry"         FORCE ROW LEVEL SECURITY;

ALTER TABLE "Habit"                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Habit"                   FORCE ROW LEVEL SECURITY;

-- 3) Policies — drop first so migration is safe to re-run.

-- User: only the owning user can see/mutate their own row.
DROP POLICY IF EXISTS "user_self_access" ON "User";
CREATE POLICY "user_self_access" ON "User"
  FOR ALL TO public
  USING ("id" = app.current_user_id())
  WITH CHECK ("id" = app.current_user_id());

-- UserProfile: owned by user_id FK.
DROP POLICY IF EXISTS "user_profile_owner_access" ON "UserProfile";
CREATE POLICY "user_profile_owner_access" ON "UserProfile"
  FOR ALL TO public
  USING ("user_id" = app.current_user_id())
  WITH CHECK ("user_id" = app.current_user_id());

-- CoachSubscription: belongs to the coach; coach_id is the owning User.id.
DROP POLICY IF EXISTS "coach_subscription_owner_access" ON "CoachSubscription";
CREATE POLICY "coach_subscription_owner_access" ON "CoachSubscription"
  FOR ALL TO public
  USING ("coach_id" = app.current_user_id())
  WITH CHECK ("coach_id" = app.current_user_id());

-- CoachMessage: visible to the thread coach, client, and recorded sender.
-- All three FK columns are nullable (SET NULL on user delete) — IS NOT DISTINCT FROM
-- handles NULLs safely; = would never match NULL.
DROP POLICY IF EXISTS "coach_message_participant_access" ON "CoachMessage";
CREATE POLICY "coach_message_participant_access" ON "CoachMessage"
  FOR ALL TO public
  USING (
    "coach_id"   IS NOT DISTINCT FROM app.current_user_id()
    OR "client_id"  IS NOT DISTINCT FROM app.current_user_id()
    OR "sender_id"  IS NOT DISTINCT FROM app.current_user_id()
  )
  WITH CHECK (
    "coach_id"   IS NOT DISTINCT FROM app.current_user_id()
    OR "client_id"  IS NOT DISTINCT FROM app.current_user_id()
    OR "sender_id"  IS NOT DISTINCT FROM app.current_user_id()
  );

-- CheckIn: health record owned by client; coach who submitted it may also access.
DROP POLICY IF EXISTS "check_in_client_or_coach_access" ON "CheckIn";
CREATE POLICY "check_in_client_or_coach_access" ON "CheckIn"
  FOR ALL TO public
  USING (
    "user_id" = app.current_user_id()
    OR "coach_id" IS NOT DISTINCT FROM app.current_user_id()
  )
  WITH CHECK (
    "user_id" = app.current_user_id()
    OR "coach_id" IS NOT DISTINCT FROM app.current_user_id()
  );

-- WeightLog: sensitive health record; only the owning user.
DROP POLICY IF EXISTS "weight_log_owner_access" ON "WeightLog";
CREATE POLICY "weight_log_owner_access" ON "WeightLog"
  FOR ALL TO public
  USING ("user_id" = app.current_user_id())
  WITH CHECK ("user_id" = app.current_user_id());

-- WorkoutSession: personal training history; only the owning user.
DROP POLICY IF EXISTS "workout_session_owner_access" ON "WorkoutSession";
CREATE POLICY "workout_session_owner_access" ON "WorkoutSession"
  FOR ALL TO public
  USING ("user_id" = app.current_user_id())
  WITH CHECK ("user_id" = app.current_user_id());

-- InviteCode: managed by the issuing coach; sub-coach attribution via invited_by_user_id.
DROP POLICY IF EXISTS "invite_code_coach_owner_access" ON "InviteCode";
CREATE POLICY "invite_code_coach_owner_access" ON "InviteCode"
  FOR ALL TO public
  USING (
    "coach_id" = app.current_user_id()
    OR "invited_by_user_id" IS NOT DISTINCT FROM app.current_user_id()
  )
  WITH CHECK (
    "coach_id" = app.current_user_id()
    OR "invited_by_user_id" IS NOT DISTINCT FROM app.current_user_id()
  );

-- Notification: per-user delivery record; must not leak across accounts.
DROP POLICY IF EXISTS "notification_owner_access" ON "Notification";
CREATE POLICY "notification_owner_access" ON "Notification"
  FOR ALL TO public
  USING ("user_id" = app.current_user_id())
  WITH CHECK ("user_id" = app.current_user_id());

-- NotificationPreferences: per-user settings row.
DROP POLICY IF EXISTS "notification_prefs_owner_access" ON "NotificationPreferences";
CREATE POLICY "notification_prefs_owner_access" ON "NotificationPreferences"
  FOR ALL TO public
  USING ("user_id" = app.current_user_id())
  WITH CHECK ("user_id" = app.current_user_id());

-- DataExportRequest: GDPR export record; only the requesting user.
DROP POLICY IF EXISTS "data_export_owner_access" ON "DataExportRequest";
CREATE POLICY "data_export_owner_access" ON "DataExportRequest"
  FOR ALL TO public
  USING ("user_id" = app.current_user_id())
  WITH CHECK ("user_id" = app.current_user_id());

-- BloodworkPanel: client owns the panel; the assigned coach can also read/write.
-- reviewed_by_id is a reviewer audit column — not a primary owner, excluded from policy.
DROP POLICY IF EXISTS "bloodwork_panel_client_or_coach_access" ON "BloodworkPanel";
CREATE POLICY "bloodwork_panel_client_or_coach_access" ON "BloodworkPanel"
  FOR ALL TO public
  USING (
    "client_id" = app.current_user_id()
    OR "coach_id" IS NOT DISTINCT FROM app.current_user_id()
  )
  WITH CHECK (
    "client_id" = app.current_user_id()
    OR "coach_id" IS NOT DISTINCT FROM app.current_user_id()
  );

-- LoggedFoodEntry: food log owned by the logging user.
DROP POLICY IF EXISTS "food_entry_owner_access" ON "LoggedFoodEntry";
CREATE POLICY "food_entry_owner_access" ON "LoggedFoodEntry"
  FOR ALL TO public
  USING ("user_id" = app.current_user_id())
  WITH CHECK ("user_id" = app.current_user_id());

-- Habit: habit definition owned by the creating user.
-- HabitLog has no user_id — it is reachable only through its parent Habit row,
-- which is already protected here. No direct policy on HabitLog needed.
DROP POLICY IF EXISTS "habit_owner_access" ON "Habit";
CREATE POLICY "habit_owner_access" ON "Habit"
  FOR ALL TO public
  USING ("user_id" = app.current_user_id())
  WITH CHECK ("user_id" = app.current_user_id());

-- 4) Grant app schema to standard Supabase roles.
GRANT USAGE ON SCHEMA app TO service_role, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.current_user_id() TO service_role, anon, authenticated;

COMMIT;

-- =============================================================================
-- ROLLBACK (run manually if needed):
-- =============================================================================
-- BEGIN;
-- DROP POLICY IF EXISTS "user_self_access"                    ON "User";
-- DROP POLICY IF EXISTS "user_profile_owner_access"           ON "UserProfile";
-- DROP POLICY IF EXISTS "coach_subscription_owner_access"     ON "CoachSubscription";
-- DROP POLICY IF EXISTS "coach_message_participant_access"    ON "CoachMessage";
-- DROP POLICY IF EXISTS "check_in_client_or_coach_access"     ON "CheckIn";
-- DROP POLICY IF EXISTS "weight_log_owner_access"             ON "WeightLog";
-- DROP POLICY IF EXISTS "workout_session_owner_access"        ON "WorkoutSession";
-- DROP POLICY IF EXISTS "invite_code_coach_owner_access"      ON "InviteCode";
-- DROP POLICY IF EXISTS "notification_owner_access"           ON "Notification";
-- DROP POLICY IF EXISTS "notification_prefs_owner_access"     ON "NotificationPreferences";
-- DROP POLICY IF EXISTS "data_export_owner_access"            ON "DataExportRequest";
-- DROP POLICY IF EXISTS "bloodwork_panel_client_or_coach_access" ON "BloodworkPanel";
-- DROP POLICY IF EXISTS "food_entry_owner_access"             ON "LoggedFoodEntry";
-- DROP POLICY IF EXISTS "habit_owner_access"                  ON "Habit";
-- ALTER TABLE "User"                    DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE "UserProfile"             DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE "CoachSubscription"       DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE "CoachMessage"            DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE "CheckIn"                 DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE "WeightLog"               DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE "WorkoutSession"          DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE "InviteCode"              DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE "Notification"            DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE "NotificationPreferences" DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE "DataExportRequest"       DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE "BloodworkPanel"          DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE "LoggedFoodEntry"         DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE "Habit"                   DISABLE ROW LEVEL SECURITY;
-- DROP FUNCTION IF EXISTS app.current_user_id();
-- COMMIT;
