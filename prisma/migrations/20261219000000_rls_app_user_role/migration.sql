-- Wave 1.5 / A1 — RLS application role.
--
-- Creates the least-privilege `app_user` role that request-scoped Prisma
-- queries will run as (wired in A2). The role is NOBYPASSRLS, so once A3
-- attaches policies it is fully subject to them — unlike the migration/admin
-- role used to apply this very migration.
--
-- PASSWORD: not set here. Prisma migrations cannot read environment variables
-- at apply time, so the role is created without a password and each environment
-- MUST run, out-of-band, immediately after deploy:
--     ALTER ROLE app_user WITH PASSWORD '<from-secret-manager>';
-- See prisma/migrations/20261219000000_rls_app_user_role/README.md.
--
-- No table-level RLS is enabled and no policies are created in this migration
-- (those land in A3). Granting DML here is safe: with NOBYPASSRLS, A3's policies
-- will constrain what these grants can actually reach.

-- Idempotent role creation: CREATE ROLE has no IF NOT EXISTS, so guard it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user WITH LOGIN NOBYPASSRLS;
  END IF;
END
$$;

-- Connection + schema visibility.
GRANT CONNECT ON DATABASE current_database() TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;

-- DML on everything that exists today.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;

-- DML on everything created hereafter (new tables/sequences from later migrations).
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;
