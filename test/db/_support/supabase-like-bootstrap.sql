-- Supabase-like bootstrap for the S1 isolated PostgreSQL 17.6 lane.
--
-- Builds on scripts/ci/supabase-shim.sql (roles + auth.*) and adds the pieces
-- that reproduce the observed production pre-state and PostgREST role model:
--   * a non-superuser, BYPASSRLS, table-owning `postgres` role (Supabase's
--     `postgres` is NOT a superuser; Prisma migrate runs as it);
--   * `authenticator` LOGIN NOINHERIT that can SET ROLE anon/authenticated/
--     service_role exactly as PostgREST does;
--   * Supabase's ALTER DEFAULT PRIVILEGES for `postgres` in schema public
--     (ALL on tables/sequences/functions to anon, authenticated, service_role)
--     — this is the mechanism that gave new tables and new partitions CRUD for
--     the API roles in the first place. Without it, a local run would not
--     reproduce the 18-relation finding.
-- LOCAL ONLY. Never run against a real Supabase database.
-- Run as the cluster superuser, connected to the target database.

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
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'postgres') THEN
    CREATE ROLE postgres LOGIN NOSUPERUSER CREATEDB CREATEROLE BYPASSRLS PASSWORD 'postgres_local_synthetic';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator LOGIN NOINHERIT NOBYPASSRLS PASSWORD 'authenticator_local_synthetic';
  END IF;
END
$$;

GRANT anon, authenticated, service_role TO authenticator;
GRANT anon, authenticated, service_role TO postgres WITH ADMIN OPTION;

-- database + schema ownership like Supabase (public owned by postgres in effect)
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I OWNER TO postgres', current_database());
END
$$;
ALTER SCHEMA public OWNER TO postgres;
GRANT USAGE, CREATE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Supabase default privileges (source: supabase/postgres roles.sql) for objects
-- created by postgres in public.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;

-- auth schema + helpers (same shapes as scripts/ci/supabase-shim.sql)
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
  SELECT NULLIF(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
$f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT NULLIF(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '')
$f$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $f$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$f$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role, postgres;

-- extensions the migration chain may need (Supabase ships them pre-installed)
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gist;
