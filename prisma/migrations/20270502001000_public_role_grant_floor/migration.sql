-- RLSGRANTS (agent 145): the public API roles get a grant floor.
--
-- Every public table has row level security on, but the table grants were the
-- Supabase defaults: anon and authenticated held INSERT, UPDATE, DELETE,
-- TRUNCATE, REFERENCES and TRIGGER (and MAINTAIN on Postgres 17) on almost
-- every public table, and the default privileges of role postgres in schema
-- public handed every NEW table the same. Row rules never stop TRUNCATE, and
-- REFERENCES / TRIGGER / MAINTAIN are not row operations at all.
--
-- This migration:
--   1. revokes TRUNCATE, TRIGGER, REFERENCES (and MAINTAIN where the server
--      has it) on every public table from anon and authenticated;
--   2. revokes INSERT, UPDATE and DELETE on every public table from anon.
--      Nothing writes as anon: the backend uses service_role, and neither the
--      backend nor the mobile app makes a Data API table call (their Supabase
--      clients do auth, storage and realtime broadcast only). anon has no user
--      id, so every row rule already denied it; this removes the grant itself;
--   3. removes the same rights from the default privileges of role postgres
--      in schema public, so new tables start without them.
-- Unchanged: SELECT for both roles, INSERT/UPDATE/DELETE for authenticated
-- (row rules govern them), sequences, functions, the storage schema,
-- service_role and postgres.
--
-- Exact rollback: before revoking, every grant this removes (table, column and
-- default-privilege level) is recorded in app.public_role_grant_floor_backup;
-- down.sql re-grants exactly those rows and drops the table. The table is in
-- schema app (not part of the Prisma schema), has RLS on and forced with no
-- policy, and no API role can read it.
--
-- The migration checks its own result and aborts (rolling everything back) if
-- anon or authenticated still holds a revoked right anywhere in scope.
-- CI guard: scripts/ci/assert-rls-floor.mjs check f (rls-floor-guard).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) <> 2 THEN
    RAISE EXCEPTION 'public_role_grant_floor: Supabase API roles anon/authenticated are missing';
  END IF;
END
$$;

-- What anon/authenticated hold today inside the floor's scope, one row per
-- grant: a public relation, one of its columns, or postgres's default
-- privileges for new tables in public (target 'DEFAULT').
CREATE TEMP VIEW grant_floor_held AS
WITH held AS (
  SELECT format('%I.%I', n.nspname, c.relname) AS target, '' AS col, a.grantee, a.privilege_type, a.is_grantable
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  UNION ALL
  SELECT format('%I.%I', n.nspname, c.relname), quote_ident(att.attname), a.grantee, a.privilege_type, a.is_grantable
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute att ON att.attrelid = c.oid AND att.attnum > 0 AND NOT att.attisdropped
  CROSS JOIN LATERAL aclexplode(att.attacl) a
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  UNION ALL
  SELECT 'DEFAULT', '', a.grantee, a.privilege_type, a.is_grantable
  FROM pg_default_acl d
  CROSS JOIN LATERAL aclexplode(d.defaclacl) a
  WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 'public'::regnamespace AND d.defaclobjtype = 'r'
)
SELECT h.target, h.col, r.rolname AS grantee, h.privilege_type AS privilege, bool_or(h.is_grantable) AS grantable
FROM held h
JOIN pg_roles r ON r.oid = h.grantee
WHERE (r.rolname IN ('anon', 'authenticated') AND h.privilege_type IN ('TRUNCATE', 'TRIGGER', 'REFERENCES', 'MAINTAIN'))
   OR (r.rolname = 'anon' AND h.privilege_type IN ('INSERT', 'UPDATE', 'DELETE'))
GROUP BY 1, 2, 3, 4;

CREATE TABLE app.public_role_grant_floor_backup (
  target    text    NOT NULL,
  col       text    NOT NULL DEFAULT '',
  grantee   text    NOT NULL,
  privilege text    NOT NULL,
  grantable boolean NOT NULL DEFAULT false,
  PRIMARY KEY (target, col, grantee, privilege)
);
INSERT INTO app.public_role_grant_floor_backup SELECT * FROM grant_floor_held;
REVOKE ALL ON TABLE app.public_role_grant_floor_backup FROM PUBLIC, anon, authenticated;
ALTER TABLE app.public_role_grant_floor_backup ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.public_role_grant_floor_backup FORCE ROW LEVEL SECURITY;

-- A table-level REVOKE also removes the same right from every column.
REVOKE TRUNCATE, TRIGGER, REFERENCES ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE ON TABLES FROM anon;

DO $$
BEGIN
  -- MAINTAIN exists from Postgres 17 (production); CI runs Postgres 15.
  IF current_setting('server_version_num')::int >= 170000 THEN
    EXECUTE 'REVOKE MAINTAIN ON ALL TABLES IN SCHEMA public FROM anon, authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE MAINTAIN ON TABLES FROM anon, authenticated';
  END IF;
END
$$;

DO $$
DECLARE
  left_over text;
BEGIN
  SELECT string_agg(format('%s%s %s %s', target, nullif('(' || col || ')', '()'), grantee, privilege), ', ' ORDER BY target, col, grantee, privilege)
    INTO left_over FROM grant_floor_held;
  IF left_over IS NOT NULL THEN
    RAISE EXCEPTION 'public_role_grant_floor: still granted after the revoke: %', left_over;
  END IF;
END
$$;

DROP VIEW grant_floor_held;

COMMIT;
