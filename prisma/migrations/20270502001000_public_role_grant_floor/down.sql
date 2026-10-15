-- Down for 20270502001000_public_role_grant_floor (RLSGRANTS).
-- Re-grants exactly what the migration revoked, as recorded in
-- app.public_role_grant_floor_backup (table, column and default-privilege
-- rows, with their grant option), then drops that table. This brings back the
-- gap: anon and authenticated could again truncate public tables, add
-- triggers and references, and anon could again hold write grants. A table
-- dropped since the migration is skipped. No data changes.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  g record;
  opt text;
BEGIN
  IF to_regclass('app.public_role_grant_floor_backup') IS NULL THEN
    RAISE EXCEPTION 'public_role_grant_floor down: app.public_role_grant_floor_backup is missing; nothing to restore from';
  END IF;
  -- The owner reads its own forced-RLS table only without FORCE.
  ALTER TABLE app.public_role_grant_floor_backup NO FORCE ROW LEVEL SECURITY;
  FOR g IN SELECT * FROM app.public_role_grant_floor_backup ORDER BY target, col, grantee, privilege LOOP
    opt := CASE WHEN g.grantable THEN ' WITH GRANT OPTION' ELSE '' END;
    IF g.target = 'DEFAULT' THEN
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT %s ON TABLES TO %I%s', g.privilege, g.grantee, opt);
    ELSIF to_regclass(g.target) IS NULL THEN
      RAISE NOTICE 'public_role_grant_floor down: % no longer exists; skipped', g.target;
    ELSIF g.col = '' THEN
      EXECUTE format('GRANT %s ON TABLE %s TO %I%s', g.privilege, g.target, g.grantee, opt);
    ELSE
      EXECUTE format('GRANT %s (%s) ON TABLE %s TO %I%s', g.privilege, g.col, g.target, g.grantee, opt);
    END IF;
  END LOOP;
END
$$;

DROP TABLE app.public_role_grant_floor_backup;

COMMIT;
