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
--
-- `FOR ROLE postgres` scopes these defaults to objects created by the
-- migration-applying role (`postgres` on Supabase). ALTER DEFAULT PRIVILEGES
-- only affects objects created by the named role(s); without FOR ROLE it would
-- silently apply to objects created by the *current* role only, which is the
-- migration runner here but is brittle to assume. If a different role ever
-- creates tables in `public` (e.g. a future tooling role), it MUST run its own
-- ALTER DEFAULT PRIVILEGES grant for `app_user`, or those tables will not be
-- reachable by the app role.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;

-- Prisma's migration bookkeeping table must never be reachable by the app role:
-- it is admin/migration surface, not tenant data, and (once A3 enables RLS) it
-- would otherwise be an unguarded table the app role could read/write. The
-- broad GRANT above may have included it, so revoke explicitly. Guarded so a
-- fresh baseline (where the table does not yet exist) does not fail.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = '_prisma_migrations'
  ) THEN
    REVOKE ALL ON TABLE public._prisma_migrations FROM app_user;
  END IF;
END
$$;
