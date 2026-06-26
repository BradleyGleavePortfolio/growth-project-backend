-- Supabase environment bootstrap for the migration dry-run CI gate.
--
-- WHY THIS FILE EXISTS
-- Production runs on a Supabase-managed Postgres instance, which ships an
-- `auth` schema (with `auth.uid()`), and the `service_role`, `authenticated`,
-- and `anon` roles out of the box. The `Forward migration applies cleanly` CI
-- gate (.github/workflows/migration-dry-run.yml) spins up a bare
-- `postgres:15.18` service that provides none of these. ~10 committed
-- migrations call `auth.uid()` and ~29 GRANT to / create policies for the
-- Supabase roles, so the chain cannot apply on bare Postgres without this
-- scaffolding.
--
-- WHY THE LEADING UNDERSCORE
-- Prisma's migration engine only treats *directories* under
-- prisma/migrations/ as migrations. A plain `.sql` file (especially one whose
-- name starts with `_`) is ignored by `prisma migrate deploy` / `migrate
-- status`. This file is therefore invisible to Prisma and is only ever run
-- explicitly by the CI workflow via `psql -f` before `prisma migrate deploy`.
--
-- IDEMPOTENT BY DESIGN
-- Safe to run repeatedly. Uses CREATE SCHEMA IF NOT EXISTS, CREATE OR REPLACE
-- FUNCTION, and guarded CREATE ROLE blocks so re-runs never error.
--
-- CI-ONLY: this is NOT applied to staging or production (which already have
-- the real Supabase-provided objects). It exists purely to make the dry-run
-- environment match production's preconditions.

-- 1. auth schema --------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS auth;

-- 2. auth.uid() stub ----------------------------------------------------------
-- Supabase's auth.uid() reads the current request's JWT `sub` claim and
-- returns it as a uuid. There is no JWT context during a migration dry-run, so
-- the stub returns NULL::uuid. This matches Supabase's signature
-- (RETURNS uuid, STABLE) and is sufficient because the migrations only need
-- the function to EXIST and be type-correct so policy/DDL expressions compile;
-- no migration depends on a non-NULL return value at apply time.
CREATE OR REPLACE FUNCTION auth.uid()
    RETURNS uuid
    LANGUAGE sql
    STABLE
AS $$ SELECT NULL::uuid $$;

-- 3. Supabase-provided roles --------------------------------------------------
-- service_role: backend/service-role connections; bypasses RLS on Supabase.
-- authenticated / anon: the two PostgREST request roles.
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role NOLOGIN BYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN;
    END IF;
END $$;
