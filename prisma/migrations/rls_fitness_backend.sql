-- RLS defense-in-depth migration for growth-project-backend (fitness)
-- Prisma stores application UUIDs as TEXT in this schema, so policies compare
-- against app.current_user_id() as TEXT rather than casting to uuid.
-- Prisma's production connection uses Supabase service_role and therefore
-- bypasses RLS; these policies protect direct Studio/dashboard access and any
-- future anon/authenticated-key code path.

BEGIN;

-- 1) service_role already has BYPASSRLS on Supabase managed instances — no ALTER needed.
-- (ALTER ROLE service_role BYPASSRLS would fail with 42501 on Supabase; it's the default.)

-- Helper returns NULL when the application has not set the session variable.
-- NULL makes every owner predicate evaluate false instead of raising on missing
-- configuration; use SET app.current_user_id = '<User.id>' per request.
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

-- 2) Enable and force RLS on tenant-scoped tables.
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "User" FORCE ROW LEVEL SECURITY;
ALTER TABLE "UserProfile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserProfile" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ConnectAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ConnectAccount" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ConnectCustomer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ConnectCustomer" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ClientPurchase" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClientPurchase" FORCE ROW LEVEL SECURITY;
ALTER TABLE "CoachPackage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachPackage" FORCE ROW LEVEL SECURITY;
ALTER TABLE "CoachMessage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachMessage" FORCE ROW LEVEL SECURITY;
ALTER TABLE "CheckIn" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CheckIn" FORCE ROW LEVEL SECURITY;
ALTER TABLE "WeightLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WeightLog" FORCE ROW LEVEL SECURITY;
ALTER TABLE "WorkoutSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkoutSession" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Notification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Notification" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ExerciseCatalogItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExerciseCatalogItem" FORCE ROW LEVEL SECURITY;
ALTER TABLE "InviteCode" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InviteCode" FORCE ROW LEVEL SECURITY;

-- 3) Policies. Drop first so the migration is safe to re-run during staging hardening.

-- A user row contains identity and account lifecycle data; only that user may see or mutate it through non-bypass roles.
DROP POLICY IF EXISTS "user_self_access" ON "User";
CREATE POLICY "user_self_access" ON "User"
  FOR ALL TO public
  USING ("id" = app.current_user_id())
  WITH CHECK ("id" = app.current_user_id());

-- Profiles contain personal health/onboarding fields; ownership is the profile.user_id foreign key.
DROP POLICY IF EXISTS "user_profile_owner_access" ON "UserProfile";
CREATE POLICY "user_profile_owner_access" ON "UserProfile"
  FOR ALL TO public
  USING ("user_id" = app.current_user_id())
  WITH CHECK ("user_id" = app.current_user_id());

-- Stripe Connect account state belongs to the coach whose Express account is mirrored here.
DROP POLICY IF EXISTS "connect_account_coach_owner_access" ON "ConnectAccount";
CREATE POLICY "connect_account_coach_owner_access" ON "ConnectAccount"
  FOR ALL TO public
  USING ("coach_user_id" = app.current_user_id())
  WITH CHECK ("coach_user_id" = app.current_user_id());

-- Saved billing customer/card mirror belongs to the client user only.
DROP POLICY IF EXISTS "connect_customer_client_owner_access" ON "ConnectCustomer";
CREATE POLICY "connect_customer_client_owner_access" ON "ConnectCustomer"
  FOR ALL TO public
  USING ("client_user_id" = app.current_user_id())
  WITH CHECK ("client_user_id" = app.current_user_id());

-- Purchases are shared business records: clients can see their purchase and coaches can see roster revenue/entitlement state.
DROP POLICY IF EXISTS "client_purchase_client_or_coach_access" ON "ClientPurchase";
CREATE POLICY "client_purchase_client_or_coach_access" ON "ClientPurchase"
  FOR ALL TO public
  USING ("client_user_id" = app.current_user_id() OR "coach_user_id" = app.current_user_id())
  WITH CHECK ("client_user_id" = app.current_user_id() OR "coach_user_id" = app.current_user_id());

-- Coach packages are offers owned by the selling coach; anonymous clients should resolve invite/package availability through service-role API paths.
DROP POLICY IF EXISTS "coach_package_owner_access" ON "CoachPackage";
CREATE POLICY "coach_package_owner_access" ON "CoachPackage"
  FOR ALL TO public
  USING ("coach_id" = app.current_user_id())
  WITH CHECK ("coach_id" = app.current_user_id());

-- Coach messages are private to the coach/client thread participants and, defensively, the recorded sender.
DROP POLICY IF EXISTS "coach_message_participant_access" ON "CoachMessage";
CREATE POLICY "coach_message_participant_access" ON "CoachMessage"
  FOR ALL TO public
  USING ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR "sender_id" = app.current_user_id())
  WITH CHECK ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR "sender_id" = app.current_user_id());

-- Check-ins are health progress records; the client owns them and the assigned coach can read/write roster check-ins.
DROP POLICY IF EXISTS "check_in_client_or_coach_access" ON "CheckIn";
CREATE POLICY "check_in_client_or_coach_access" ON "CheckIn"
  FOR ALL TO public
  USING ("user_id" = app.current_user_id() OR "coach_id" = app.current_user_id())
  WITH CHECK ("user_id" = app.current_user_id() OR "coach_id" = app.current_user_id());

-- Weight logs are sensitive health records; only the owning user is allowed through non-bypass roles.
DROP POLICY IF EXISTS "weight_log_owner_access" ON "WeightLog";
CREATE POLICY "weight_log_owner_access" ON "WeightLog"
  FOR ALL TO public
  USING ("user_id" = app.current_user_id())
  WITH CHECK ("user_id" = app.current_user_id());

-- Workout sessions are personal training history; only the owning user is allowed through non-bypass roles.
DROP POLICY IF EXISTS "workout_session_owner_access" ON "WorkoutSession";
CREATE POLICY "workout_session_owner_access" ON "WorkoutSession"
  FOR ALL TO public
  USING ("user_id" = app.current_user_id())
  WITH CHECK ("user_id" = app.current_user_id());

-- In-app notifications are per-user delivery records and must not leak across accounts.
DROP POLICY IF EXISTS "notification_owner_access" ON "Notification";
CREATE POLICY "notification_owner_access" ON "Notification"
  FOR ALL TO public
  USING ("user_id" = app.current_user_id())
  WITH CHECK ("user_id" = app.current_user_id());

-- The exercise catalog is owner-curated global library content; non-bypass roles may read it but cannot write it.
DROP POLICY IF EXISTS "exercise_catalog_public_read" ON "ExerciseCatalogItem";
CREATE POLICY "exercise_catalog_public_read" ON "ExerciseCatalogItem"
  FOR SELECT TO public
  USING (true);

-- Invite codes are coach-owned for management; clients redeem codes through controlled service-role API endpoints.
DROP POLICY IF EXISTS "invite_code_coach_owner_access" ON "InviteCode";
CREATE POLICY "invite_code_coach_owner_access" ON "InviteCode"
  FOR ALL TO public
  USING ("coach_id" = app.current_user_id() OR "invited_by_user_id" = app.current_user_id())
  WITH CHECK ("coach_id" = app.current_user_id() OR "invited_by_user_id" = app.current_user_id());

-- 4) Grant the app schema helpers to all roles. Public schema grants are
--    already managed by Supabase; repeating them here causes no harm but
--    is unnecessary — omitted to avoid permission errors on managed instances.
GRANT USAGE ON SCHEMA app TO service_role, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.current_user_id() TO service_role, anon, authenticated;

COMMIT;

-- Rollback script (manual):
-- BEGIN;
-- DROP POLICY IF EXISTS "user_self_access" ON "User";
-- DROP POLICY IF EXISTS "user_profile_owner_access" ON "UserProfile";
-- DROP POLICY IF EXISTS "connect_account_coach_owner_access" ON "ConnectAccount";
-- DROP POLICY IF EXISTS "connect_customer_client_owner_access" ON "ConnectCustomer";
-- DROP POLICY IF EXISTS "client_purchase_client_or_coach_access" ON "ClientPurchase";
-- DROP POLICY IF EXISTS "coach_package_owner_access" ON "CoachPackage";
-- DROP POLICY IF EXISTS "coach_message_participant_access" ON "CoachMessage";
-- DROP POLICY IF EXISTS "check_in_client_or_coach_access" ON "CheckIn";
-- DROP POLICY IF EXISTS "weight_log_owner_access" ON "WeightLog";
-- DROP POLICY IF EXISTS "workout_session_owner_access" ON "WorkoutSession";
-- DROP POLICY IF EXISTS "notification_owner_access" ON "Notification";
-- DROP POLICY IF EXISTS "exercise_catalog_public_read" ON "ExerciseCatalogItem";
-- DROP POLICY IF EXISTS "invite_code_coach_owner_access" ON "InviteCode";
-- ALTER TABLE "User" DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE "UserProfile" DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE "ConnectAccount" DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE "ConnectCustomer" DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE "ClientPurchase" DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE "CoachPackage" DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE "CoachMessage" DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE "CheckIn" DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE "WeightLog" DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE "WorkoutSession" DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE "Notification" DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE "ExerciseCatalogItem" DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE "InviteCode" DISABLE ROW LEVEL SECURITY;
-- DROP FUNCTION IF EXISTS app.current_user_id();
-- COMMIT;
