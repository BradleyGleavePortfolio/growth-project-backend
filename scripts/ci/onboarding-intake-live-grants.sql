-- Fix round B607-3: table privileges for the live RLS suite.
-- Supabase grants table privileges to `authenticated`/`anon` by default; a
-- vanilla CI Postgres does not, and without them every query would fail on
-- privileges before RLS is consulted (a false "denied"). Grant exactly what a
-- Supabase project has so the RLS policies are what decides. `anon` gets
-- SELECT too so the suite proves the RESTRICTIVE anon policy, not a missing
-- grant, is what denies it.
GRANT USAGE ON SCHEMA app TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON "ClientOnboardingIntake", "ClientOnboardingIntakeRevision", "ClinicProgramSet"
  TO authenticated;
GRANT SELECT ON "ClientOnboardingIntake", "ClientOnboardingIntakeRevision" TO anon;
