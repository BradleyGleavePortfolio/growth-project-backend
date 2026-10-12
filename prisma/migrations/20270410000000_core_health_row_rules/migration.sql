-- D3 (DATA-01, DATA-02, D5-01): row rules for the core health tables, moved
-- out of the loose prisma/migrations/rls_fitness_backend.sql into a real
-- migration, plus FORCE row security on ConnectAccount and Invoice.
--
-- Production already has everything below from the loose file, so every step
-- checks the catalog first and does nothing when the flag or policy is already
-- there: on production this migration changes nothing and takes no table lock.
-- On a database rebuilt from the migration chain alone it adds what the loose
-- file used to add.
--
-- Copied from rls_fitness_backend.sql without change of meaning:
--   * ENABLE + FORCE on User, UserProfile, CoachSubscription, WeightLog,
--     WorkoutSession, InviteCode, Notification, NotificationPreferences,
--     DataExportRequest, LoggedFoodEntry, Habit; ENABLE on CheckIn and
--     BloodworkPanel (20260607000000 already forces them).
--   * The ten FOR ALL TO public policies no migration defines:
--     user_self_access, user_profile_owner_access,
--     coach_subscription_owner_access, weight_log_owner_access,
--     workout_session_owner_access, notification_owner_access,
--     notification_prefs_owner_access, data_export_owner_access,
--     food_entry_owner_access, habit_owner_access.
-- Not copied, because a later migration already replaced them by name:
--   CheckIn and BloodworkPanel policies (20260607000000 drops the loose FOR ALL
--   policy and adds narrower ones), CoachMessage (20270303000000) and
--   InviteCode (20260607000000) policies, app.current_user_id() and its grants
--   (20260704000000 pins its search_path and revokes anon).
-- New here: FORCE on ConnectAccount and Invoice (20260606000003 enabled RLS but
-- never forced it). The server's database role bypasses RLS: Prisma's
-- connection uses service_role (rls_fitness_backend.sql header;
-- 20270409000000), and production already forces User and ConnectAccount,
-- which the server writes with no RLS context, so forcing Invoice cannot block
-- the server. Reverse: down.sql.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'User', 'UserProfile', 'CoachSubscription', 'CheckIn', 'WeightLog',
    'WorkoutSession', 'InviteCode', 'Notification', 'NotificationPreferences',
    'DataExportRequest', 'BloodworkPanel', 'LoggedFoodEntry', 'Habit',
    'ConnectAccount', 'Invoice'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = 'public' AND c.relname = t AND c.relrowsecurity) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = 'public' AND c.relname = t AND c.relforcerowsecurity) THEN
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END
$$;

-- Owner-only policies, verbatim from rls_fitness_backend.sql. Each is created
-- only when no policy of that name exists on the table.
DO $$
DECLARE
  p text[];
BEGIN
  FOREACH p SLICE 1 IN ARRAY ARRAY[
    ['User',                    'user_self_access',                'id'],
    ['UserProfile',             'user_profile_owner_access',       'user_id'],
    ['CoachSubscription',       'coach_subscription_owner_access', 'coach_id'],
    ['WeightLog',               'weight_log_owner_access',         'user_id'],
    ['WorkoutSession',          'workout_session_owner_access',    'user_id'],
    ['Notification',            'notification_owner_access',       'user_id'],
    ['NotificationPreferences', 'notification_prefs_owner_access', 'user_id'],
    ['DataExportRequest',       'data_export_owner_access',        'user_id'],
    ['LoggedFoodEntry',         'food_entry_owner_access',         'user_id'],
    ['Habit',                   'habit_owner_access',              'user_id']
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies
                   WHERE schemaname = 'public' AND tablename = p[1] AND policyname = p[2]) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO public USING (%I = app.current_user_id()) WITH CHECK (%I = app.current_user_id())',
        p[2], p[1], p[3], p[3]);
    END IF;
  END LOOP;
END
$$;
