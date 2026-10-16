-- Down for 20270502003500_billing_rows_server_only (BILLRAW).
-- Re-grants exactly what the migration revoked, as recorded in
-- app.billing_api_grant_backup (table and column rows, with their grant
-- option), then drops that table. This brings back the gap: a session as
-- authenticated with app.current_user_id set reads its party's raw billing
-- rows again (a former coach included). A table dropped since the migration
-- is skipped. No data changes.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  g record;
BEGIN
  IF to_regclass('app.billing_api_grant_backup') IS NULL THEN
    RAISE EXCEPTION 'billing_rows_server_only down: app.billing_api_grant_backup is missing; nothing to restore from';
  END IF;
  -- The owner reads its own forced-RLS table only without FORCE.
  ALTER TABLE app.billing_api_grant_backup NO FORCE ROW LEVEL SECURITY;
  FOR g IN SELECT * FROM app.billing_api_grant_backup ORDER BY target, col, grantee, privilege LOOP
    IF to_regclass(g.target) IS NULL THEN
      RAISE NOTICE 'billing_rows_server_only down: % no longer exists; skipped', g.target;
    ELSE
      EXECUTE format('GRANT %s%s ON TABLE %s TO %s%s', g.privilege, nullif(' (' || g.col || ')', ' ()'), g.target,
        CASE WHEN g.grantee = 'PUBLIC' THEN 'PUBLIC' ELSE quote_ident(g.grantee) END,
        CASE WHEN g.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END IF;
  END LOOP;
END
$$;

DROP TABLE app.billing_api_grant_backup;

COMMIT;
