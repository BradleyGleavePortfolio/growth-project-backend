-- S1-DB-01 catalog verifier — the ONLY truthful post-deploy/post-restore check.
--
-- Prisma's `migrate status` answers from _prisma_migrations, not from the
-- catalog. If this migration's DDL is reversed out-of-band (rollback.sql,
-- manual psql, restore of an older dump) Prisma still prints "Database schema
-- is up to date!" and `migrate resolve --rolled-back` refuses (row not failed).
-- This script inspects pg_class / pg_policy / ACLs / pg_proc directly and
-- RAISEs (psql exit 3 with -v ON_ERROR_STOP=1) on any drift.
--
-- Usage (read-only; safe against any environment that has the API roles):
--   psql "$DIRECT_URL" -X -v ON_ERROR_STOP=1 -f prisma/migrations/20261224000000_rls_close_public_exposure/verify.sql
-- Prisma is NOT a substitute: `prisma db execute --file verify.sql` also works
-- but exit codes are less precise. Prisma migration folders may contain extra
-- files; only migration.sql is applied.

DO $verify$
DECLARE
  problems text[] := ARRAY[]::text[];
  t text;
  r record;
  fixed_tables text[] := ARRAY[
    'ClientAssetGrant', 'CoachMediaAsset', 'CoachPackageContent',
    'DripResolverMarker', 'DunningAttempt', 'MuxProcessedEvent', 'NudgeLog',
    'PaymentRecoveryToken', 'PayoutMethod', 'PurchaseFanout', 'ScheduledDrop',
    'UserAIQuota', 'coach_ltv_peak', 'recent_auth_nonce'
  ];
  relations text[];
  api_role text;
  priv text;
  fn record;
BEGIN
  -- 1) relation set = 14 fixed tables + every current partition of community_messages
  SELECT fixed_tables || COALESCE(array_agg(c.relname::text ORDER BY c.relname), ARRAY[]::text[])
    INTO relations
  FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
  WHERE i.inhparent = to_regclass('public.community_messages');

  IF to_regclass('public.community_messages') IS NULL THEN
    problems := problems || 'parent public.community_messages missing';
  END IF;

  FOREACH t IN ARRAY relations LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      problems := problems || format('relation public.%I missing', t);
      CONTINUE;
    END IF;

    SELECT c.relrowsecurity, c.relforcerowsecurity INTO r
    FROM pg_class c WHERE c.oid = to_regclass(format('public.%I', t));
    IF NOT r.relrowsecurity THEN
      problems := problems || format('%I: RLS not enabled', t);
    END IF;
    IF NOT r.relforcerowsecurity THEN
      problems := problems || format('%I: RLS not forced', t);
    END IF;

    -- policies: a PERMISSIVE service_role ALL policy, RESTRICTIVE deny-all for anon and authenticated,
    -- and NO permissive policy that grants anon/authenticated/public anything on these server-only relations.
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy p
      WHERE p.polrelid = to_regclass(format('public.%I', t))
        AND p.polpermissive AND p.polcmd = '*'
        AND p.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'service_role')]::oid[]
    ) THEN
      problems := problems || format('%I: service_role bypass policy missing', t);
    END IF;

    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_policy p
        WHERE p.polrelid = to_regclass(format('public.%I', t))
          AND NOT p.polpermissive AND p.polcmd = '*'
          AND p.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = api_role)]::oid[]
          AND pg_get_expr(p.polqual, p.polrelid) = 'false'
          AND pg_get_expr(p.polwithcheck, p.polrelid) = 'false'
      ) THEN
        problems := problems || format('%I: restrictive deny-all policy for %s missing', t, api_role);
      END IF;

      IF EXISTS (
        SELECT 1 FROM pg_policy p
        WHERE p.polrelid = to_regclass(format('public.%I', t))
          AND p.polpermissive
          AND (p.polroles = '{0}'::oid[]  -- PUBLIC
               OR (SELECT oid FROM pg_roles WHERE rolname = api_role) = ANY (p.polroles))
      ) THEN
        problems := problems || format('%I: unexpected PERMISSIVE policy reachable by %s', t, api_role);
      END IF;

      -- effective table privileges (includes grants inherited via PUBLIC or role membership)
      FOREACH priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
        IF has_table_privilege(api_role, format('public.%I', t), priv) THEN
          problems := problems || format('%I: %s still holds %s', t, api_role, priv);
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  -- 2) the four advisor-flagged functions carry a pinned search_path and the
  --    partition helpers are not executable by the API roles.
  FOR fn IN
    SELECT n.nspname, p.proname, p.oid, p.proconfig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE (n.nspname, p.proname) IN (
      ('public', 'community_messages_create_month_partition'),
      ('public', 'community_messages_protect_partition'),
      ('app', 'is_community_workspace_coach'),
      ('app', 'is_community_workspace_member'),
      ('app', 'shares_community_cohort'))
  LOOP
    IF fn.proconfig IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(fn.proconfig) cfg WHERE cfg LIKE 'search_path=%') THEN
      problems := problems || format('%s.%s: search_path not pinned', fn.nspname, fn.proname);
    END IF;
    IF fn.nspname = 'public' THEN
      FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF has_function_privilege(api_role, fn.oid, 'EXECUTE') THEN
          problems := problems || format('%s.%s: %s can EXECUTE', fn.nspname, fn.proname, api_role);
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE (n.nspname, p.proname) IN (
        ('public', 'community_messages_create_month_partition'),
        ('public', 'community_messages_protect_partition'),
        ('app', 'is_community_workspace_coach'),
        ('app', 'is_community_workspace_member'),
        ('app', 'shares_community_cohort'))) <> 5 THEN
    problems := problems || 'one or more S1-DB-01 functions missing';
  END IF;

  IF array_length(problems, 1) > 0 THEN
    RAISE EXCEPTION 'S1-DB-01 VERIFY FAILED (% problem(s)): %', array_length(problems, 1), array_to_string(problems, '; ');
  END IF;

  RAISE NOTICE 'S1-DB-01 VERIFY OK: % relations protected (% community_messages partitions), 5 functions pinned',
    array_length(relations, 1), array_length(relations, 1) - array_length(fixed_tables, 1);
END
$verify$;
