-- S1-DB-01 catalog verifier — the ONLY truthful post-deploy/post-restore check.
--
-- Prisma's `migrate status` answers from _prisma_migrations, not from the
-- catalog. If this migration's DDL is reversed out-of-band (down.sql,
-- manual psql, restore of an older dump) Prisma still prints "Database schema
-- is up to date!" and `migrate resolve --rolled-back` refuses (row not failed).
-- This script inspects pg_class / pg_policy / ACLs / pg_proc directly and
-- RAISEs on any drift.
--
-- Usage (read-only; safe against any environment that has the API roles):
--   psql "$DIRECT_URL" -X -v ON_ERROR_STOP=1 -f prisma/migrations/20261224000000_rls_close_public_exposure/verify.sql
--     -> exit 0 on OK, exit 3 on any problem.
--   npx prisma db execute --url "$DIRECT_URL" --file prisma/migrations/20261224000000_rls_close_public_exposure/verify.sql
--     -> exit 0 on OK, non-zero on any problem (the RAISE EXCEPTION propagates as a
--        failed command). The exception text carries the classification below in
--        both routes. The non-zero/zero exit behaviour of BOTH routes is asserted by
--        test/db/s1-rls-close-public-exposure.sh on the synthetic fixture.
-- Prisma migration folders may contain extra files; only migration.sql is applied.
--
-- FAILURE CLASSES (all fail the gate; the class tells the operator what kind of
-- problem it is, it never downgrades one):
--   EXPOSURE      an API role (anon/authenticated/PUBLIC) can reach a server-only
--                 relation or helper, or an S1-DB-01 hardening invariant is gone
--                 (RLS not enabled/forced, deny-all policy missing, permissive
--                 policy reachable, table privilege held, helper EXECUTE held,
--                 search_path unpinned). This is the security regression class.
--   ALLOWED-PATH  the backend path is broken or a PRECONDITION this migration
--                 relies on but does NOT establish is missing: service_role has
--                 lost a table privilege or its bypass policy, a partition is
--                 detached, a relation/function is missing.
--
-- PRECONDITIONS this migration RELIES ON and does NOT establish (verified here
-- as ALLOWED-PATH, never auto-repaired; S1-R2B-03/-04 disposition):
--   P1 service_role holds SELECT/INSERT/UPDATE/DELETE on every protected
--      relation. On Supabase this comes from the project's ALTER DEFAULT
--      PRIVILEGES; on a non-Supabase target from the owner's grants
--      (test/db/_support/supabase-like-bootstrap.sql reproduces it). The
--      migration's comment "nothing is granted that was not already granted"
--      means exactly this: it adds no GRANT for service_role on tables, so a
--      target that never had the grant fails this verifier and must be fixed by
--      whoever owns the grant policy — NOT by widening this migration.
--   P2 the relations are owned by a role the migration runs as (postgres on
--      Supabase); ALTER TABLE / CREATE POLICY require ownership. Ownership is
--      not asserted here because it is target-specific; a failed deploy with
--      SQLSTATE 42501 is the symptom.
--   P3 roles anon, authenticated and service_role exist (migration raises if not).
--   P4 public.community_messages exists and is the partitioned parent.
-- Established BY the migration (and therefore verified as EXPOSURE when absent):
--   RLS enabled+forced, deny-all RESTRICTIVE policies, service_role PERMISSIVE
--   policy (verified as ALLOWED-PATH when missing), REVOKE of API-role table
--   privileges, helper functions with pinned search_path and EXECUTE revoked from
--   PUBLIC/anon/authenticated (EXECUTE to service_role IS granted by the migration).

DO $verify$
DECLARE
  exposure text[] := ARRAY[]::text[];
  allowed  text[] := ARRAY[]::text[];
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
  fn_expected int := 0;
  sp text;
BEGIN
  -- 1) relation set = 14 fixed tables + every current partition of community_messages
  SELECT fixed_tables || COALESCE(array_agg(c.relname::text ORDER BY c.relname), ARRAY[]::text[])
    INTO relations
  FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
  WHERE i.inhparent = to_regclass('public.community_messages');

  IF to_regclass('public.community_messages') IS NULL THEN
    allowed := array_append(allowed, 'PRECONDITION P4: parent public.community_messages missing'::text);
  END IF;

  FOREACH t IN ARRAY relations LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      allowed := allowed || format('PRECONDITION: relation public.%I missing', t);
      CONTINUE;
    END IF;

    SELECT c.relrowsecurity, c.relforcerowsecurity INTO r
    FROM pg_class c WHERE c.oid = to_regclass(format('public.%I', t));
    IF NOT r.relrowsecurity THEN
      exposure := exposure || format('%I: RLS not enabled', t);
    END IF;
    IF NOT r.relforcerowsecurity THEN
      exposure := exposure || format('%I: RLS not forced', t);
    END IF;

    -- policies: a PERMISSIVE service_role ALL policy with USING (true) WITH CHECK (true),
    -- RESTRICTIVE deny-all for anon and authenticated, and NO permissive policy that
    -- grants anon/authenticated/public anything on these server-only relations.
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy p
      WHERE p.polrelid = to_regclass(format('public.%I', t))
        AND p.polpermissive AND p.polcmd = '*'
        AND p.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'service_role')]::oid[]
        AND pg_get_expr(p.polqual, p.polrelid) = 'true'
        AND pg_get_expr(p.polwithcheck, p.polrelid) = 'true'
    ) THEN
      allowed := allowed || format('%I: service_role bypass policy (ALL, USING true, WITH CHECK true) missing', t);
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
        exposure := exposure || format('%I: restrictive deny-all policy for %s missing', t, api_role);
      END IF;

      IF EXISTS (
        SELECT 1 FROM pg_policy p
        WHERE p.polrelid = to_regclass(format('public.%I', t))
          AND p.polpermissive
          AND (p.polroles = '{0}'::oid[]  -- PUBLIC
               OR (SELECT oid FROM pg_roles WHERE rolname = api_role) = ANY (p.polroles))
      ) THEN
        exposure := exposure || format('%I: unexpected PERMISSIVE policy reachable by %s', t, api_role);
      END IF;

      -- effective table privileges (includes grants inherited via PUBLIC or role membership)
      FOREACH priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
        IF has_table_privilege(api_role, format('public.%I', t), priv) THEN
          exposure := exposure || format('%I: %s still holds %s', t, api_role, priv);
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  -- 1b) allowed path is intact (PRECONDITION P1): service_role keeps all four table
  --     privileges on every protected relation (deny-only proof is not enough), and
  --     every partition is still attached to the parent (parent-path routing intact).
  FOREACH t IN ARRAY relations LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN CONTINUE; END IF;
    FOREACH priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('service_role', format('public.%I', t), priv) THEN
        allowed := allowed || format('%s: service_role lost %s', t, priv);
      END IF;
    END LOOP;
  END LOOP;
  IF (SELECT count(*) FROM pg_inherits WHERE inhparent = to_regclass('public.community_messages')) < 1 THEN
    allowed := array_append(allowed, 'community_messages has no attached partitions'::text);
  END IF;
  IF NOT (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE NOTICE 'S1-DB-01 VERIFY NOTE: current role % is not BYPASSRLS; RLS applies to this session', current_user;
  END IF;

  -- 2) the five S1-DB-01 functions exist with EXACT signatures, carry the EXACT pinned
  --    search_path the migration sets, and the public partition helpers are not
  --    executable by the API roles (EXECUTE was revoked from PUBLIC/anon/authenticated).
  FOR fn IN
    SELECT n.nspname, p.proname, p.oid, p.proconfig,
           pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE (n.nspname, p.proname) IN (
      ('public', 'community_messages_create_month_partition'),
      ('public', 'community_messages_protect_partition'),
      ('app', 'is_community_workspace_coach'),
      ('app', 'is_community_workspace_member'),
      ('app', 'shares_community_cohort'))
  LOOP
    -- exact signature (any other overload is counted as unexpected, not as the helper)
    IF (fn.nspname, fn.proname, fn.args) NOT IN (
        ('public', 'community_messages_create_month_partition', 'p_month date'),
        ('public', 'community_messages_protect_partition', 'p_partition regclass'),
        ('app', 'is_community_workspace_coach', 'p_workspace_id uuid'),
        ('app', 'is_community_workspace_member', 'p_workspace_id uuid'),
        ('app', 'shares_community_cohort', 'p_cohort_id uuid')) THEN
      exposure := exposure || format('%s.%s(%s): unexpected overload/signature', fn.nspname, fn.proname, fn.args);
      CONTINUE;
    END IF;
    fn_expected := fn_expected + 1;

    SELECT cfg INTO sp FROM unnest(fn.proconfig) cfg WHERE cfg LIKE 'search_path=%' LIMIT 1;
    IF fn.nspname = 'app' THEN
      -- migration: SET search_path = ''  (catalog serialises the empty list as "" )
      IF sp IS NULL OR sp NOT IN ('search_path=""', 'search_path=') THEN
        exposure := exposure || format('%s.%s: search_path not pinned to '''' (found %s)', fn.nspname, fn.proname, coalesce(sp, 'none'));
      END IF;
    ELSE
      -- migration: SET search_path = pg_catalog, public, pg_temp
      IF sp IS NULL OR sp <> 'search_path=pg_catalog, public, pg_temp' THEN
        exposure := exposure || format('%s.%s: search_path not pinned to pg_catalog, public, pg_temp (found %s)', fn.nspname, fn.proname, coalesce(sp, 'none'));
      END IF;
      FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF has_function_privilege(api_role, fn.oid, 'EXECUTE') THEN
          exposure := exposure || format('%s.%s: %s can EXECUTE', fn.nspname, fn.proname, api_role);
        END IF;
      END LOOP;
      IF NOT has_function_privilege('service_role', fn.oid, 'EXECUTE') THEN
        allowed := allowed || format('%s.%s: service_role cannot EXECUTE (granted by the migration)', fn.nspname, fn.proname);
      END IF;
    END IF;
  END LOOP;

  IF fn_expected <> 5 THEN
    allowed := array_append(allowed, format('PRECONDITION/INSTALL: %s of 5 S1-DB-01 functions present with the expected signature', fn_expected));
  END IF;

  IF array_length(exposure, 1) > 0 OR array_length(allowed, 1) > 0 THEN
    RAISE EXCEPTION 'S1-DB-01 VERIFY FAILED (% exposure problem(s); % allowed-path problem(s)): %',
      coalesce(array_length(exposure, 1), 0), coalesce(array_length(allowed, 1), 0),
      concat_ws(' || ',
        CASE WHEN array_length(exposure, 1) > 0 THEN 'EXPOSURE: ' || array_to_string(exposure, '; ') END,
        CASE WHEN array_length(allowed, 1) > 0 THEN 'ALLOWED-PATH: ' || array_to_string(allowed, '; ') END);
  END IF;

  RAISE NOTICE 'S1-DB-01 VERIFY OK: % relations protected (% community_messages partitions), 5 functions pinned, service_role path intact',
    array_length(relations, 1), array_length(relations, 1) - array_length(fixed_tables, 1);
END
$verify$;
