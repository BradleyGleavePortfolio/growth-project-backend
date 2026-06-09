-- CI Supabase bootstrap shim
--
-- A vanilla Postgres service container does NOT have the roles, schema, and
-- helper function that Supabase provisions automatically. Our migrations
-- (anon/authenticated/service_role GRANTs, `TO <role>` RLS policies, and
-- `auth.uid()` references) assume those exist. This script stubs the bare
-- minimum so `prisma migrate deploy` and the live RLS suite can run in CI
-- against a plain Postgres image.
--
-- It is CI-only. It is NEVER applied to a real Supabase database (Supabase
-- already defines all of this). Run it as the superuser BEFORE migrations.
--
-- Role shapes follow the Supabase managed-Postgres defaults:
--   https://supabase.com/docs/guides/database/postgres/roles
-- auth.uid() shape follows the Supabase auth helper, which reads the JWT
-- `sub` claim out of the `request.jwt.claims` GUC:
--   https://supabase.com/docs/guides/database/postgres/row-level-security

-- ── Roles ────────────────────────────────────────────────────────────────
-- NOLOGIN group roles the migrations GRANT to / write policies for.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END
$$;

-- The connecting CI user (postgres) should be able to SET ROLE to these,
-- matching how Supabase's authenticator switches roles per request.
GRANT anon, authenticated, service_role TO postgres;

-- ── auth schema + helpers ──────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS auth;

-- auth.uid(): the Supabase identity helper. Reads the `sub` claim from the
-- request.jwt.claims GUC, returning NULL when unset/blank/invalid. RLS
-- policies in our migrations call this; the live RLS suite drives identity
-- through the app.current_user_id GUC instead, but auth.uid() must EXIST and
-- be resolvable for `migrate deploy` to apply those policies.
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(
    current_setting('request.jwt.claims', true)::jsonb ->> 'sub',
    ''
  )::uuid
$function$;

-- auth.role() / auth.jwt() round out the commonly-referenced helpers so any
-- policy that touches them still applies cleanly in CI.
CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(
    current_setting('request.jwt.claims', true)::jsonb ->> 'role',
    ''
  )
$function$;

CREATE OR REPLACE FUNCTION auth.jwt()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $function$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  )
$function$;

GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
