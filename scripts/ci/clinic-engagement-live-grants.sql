-- #609 (C05 items 6-7): table privileges for the clinic engagement live RLS
-- suite. Supabase grants table privileges to `authenticated`, `anon` and
-- `service_role` by default; a vanilla CI Postgres does not, and without them
-- every query would fail on privileges before RLS is consulted (a false
-- "denied"). Grant exactly what a Supabase project has, so the RLS policies
-- are what decides. `anon` gets every privilege too, so the suite proves the
-- RESTRICTIVE anon policy, not a missing grant, is what denies it.
GRANT USAGE ON SCHEMA app TO authenticated, anon, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON "CoachWelcomeMessageSetting", "CoachWelcomeMessageJob", "WorkoutReminderDelivery"
  TO authenticated, anon, service_role;
