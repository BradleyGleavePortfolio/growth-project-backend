-- PR-RLS-01 live-suite CI bootstrap (scoped).
--
-- WHY THIS EXISTS INSTEAD OF `prisma migrate deploy`:
-- The full Prisma migration chain is NOT deployable from an empty database
-- on this repo today — it predates PR-RLS-01 and is a pre-existing defect:
-- migration `20250724120000_subcoach_invite_token_hash` hard-ALTERs the
-- "SubCoachInvite" table, but that table is not CREATEd until
-- `20260604000000_add_team_profile_and_sub_coach_invite` (a later timestamp).
-- The live Supabase DB tolerates this only because objects were stamped in
-- after they already existed. `prisma migrate deploy` and `prisma db push`
-- both fail from empty (the latter on an unrelated FK type mismatch in
-- community_workspaces). Fixing the global migration history is out of scope
-- for PR-RLS-01 and outside its allowed file surface.
--
-- This file materializes ONLY the objects the PR-RLS-01 live suite exercises:
-- the User + TeamSubCoachAssignment relations, the app.is_user_coached_by
-- dependency helper chained by app.is_current_coach_of(), and the trigger
-- binding for enforce_subcoach_head_cap(). The five HARDENED helpers
-- themselves are NOT defined here — they come from applying the PR migration
-- (prisma/migrations/20260704000000_rls01_helper_searchpath_hibp/migration.sql)
-- on top of this bootstrap, so the suite asserts against the real migration
-- output, not a copy.
--
-- Run order in CI:
--   1. scripts/ci/supabase-shim.sql       (roles + auth schema)
--   2. scripts/ci/rls01-live-bootstrap.sql (this file: tables + dep helper)
--   3. the PR migration.sql                (the five hardened helpers)
--   4. CREATE TRIGGER trg_enforce_subcoach_head_cap (below)

CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS "User" (
  id          text PRIMARY KEY,
  supabase_id text UNIQUE,
  email       text UNIQUE,
  name        text,
  role        text NOT NULL DEFAULT 'coach',
  coach_id    text REFERENCES "User"(id)
);

CREATE TABLE IF NOT EXISTS "TeamSubCoachAssignment" (
  id            text PRIMARY KEY,
  sub_coach_id  text NOT NULL REFERENCES "User"(id),
  head_coach_id text NOT NULL REFERENCES "User"(id),
  archived_at   timestamptz
);

-- Dependency helper chained by app.is_current_coach_of(client_user_id).
-- Mirrors the live definition: true when the client's coach_id equals the
-- coach id. This helper is already SECURITY DEFINER + pinned in production
-- (out of PR-RLS-01 scope, untouched by the migration), so we recreate it
-- here with the same posture for the chained-resolution test to be faithful.
CREATE OR REPLACE FUNCTION app.is_user_coached_by(client_user_id text, coach_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM "User" WHERE id = client_user_id AND coach_id = coach_user_id
  )
$fn$;
