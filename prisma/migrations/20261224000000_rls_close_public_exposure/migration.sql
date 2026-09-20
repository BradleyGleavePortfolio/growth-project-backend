-- S1-DB-01 — close the 18-relation public RLS exposure, protect current AND
-- future community_messages partitions, and pin the mutable search_path on the
-- four advisor-flagged functions.
--
-- PROVENANCE: NEW candidate written 2026-09-20 from preserved main c23b9d9f
-- (execute/20260920-s1-database). It does not inherit any prior candidate's
-- audits or runtime proof.
--
-- WHAT WAS OBSERVED (fresh Supabase metadata, 2026-09-20 15:50 UTC, read-only):
--   18 public relations had relrowsecurity = false AND effective SELECT/INSERT/
--   UPDATE/DELETE for both PostgREST API roles (anon, authenticated). Four of
--   them are partitions of "community_messages"; the PARENT has RLS + FORCE
--   enabled, but partition tables do NOT inherit the parent's relrowsecurity
--   flag or its policies, so a direct request against
--   /rest/v1/community_messages_2026_12 was not policy-constrained. The
--   partitions were created by CREATE TABLE ... PARTITION OF, which picks up
--   Supabase's ALTER DEFAULT PRIVILEGES (ALL to anon/authenticated/service_role)
--   — that is where the CRUD grants came from.
--
-- CALLER MAP (source review of backend c23b9d9f, mobile a5933fd6, importer
-- 0111be66): every one of the 14 non-partition tables is reached ONLY through
-- the backend's Prisma client (server-side; the app's DATABASE_URL role is
-- postgres or service_role per source comments — BOTH are BYPASSRLS, and the
-- app already reads dozens of FORCE-RLS/service_role-only tables such as
-- MarketplaceAbuseSignal, so a non-BYPASSRLS serving role would already be
-- broken today). No repository issues PostgREST (.from()) or realtime
-- postgres_changes calls against any of the 18 relations; mobile uses Supabase
-- only for auth and broadcast channels. Therefore denying anon/authenticated
-- removes no legitimate caller. The actual runtime serving role is still an
-- EXTERNAL verification gap (see execution/s1-database/RUNTIME_ROLE_VERIFICATION_PACKET.md);
-- this migration is designed to be a no-op for any BYPASSRLS role and for
-- service_role, and to be applied only after that gap is closed.
--
-- PATTERN: identical to the repository convention established in
-- 20261220000000_talent_marketplace_rls / 20261220000020_marketplace_abuse_signal_rls:
--   ENABLE + FORCE RLS; PERMISSIVE FOR ALL TO service_role; RESTRICTIVE
--   deny-all TO anon and TO authenticated. Additionally table privileges are
--   REVOKEd from anon/authenticated (belt AND braces — RLS alone still
--   advertises the relation through PostgREST; a revoke does not). Nothing is
--   granted that was not already granted. No "USING (true)" is added for any
--   API role. WearableProcessedEvent (RLS enabled, no policies) is deliberately
--   left alone: deny-by-default is the intended boundary there.
--
-- LOCK / TIMEOUT BOUNDS: ALTER TABLE ... ROW LEVEL SECURITY, REVOKE and
-- CREATE POLICY each take a brief ACCESS EXCLUSIVE lock. A long-running app
-- transaction would make this migration QUEUE and, while queued, block every
-- new query on that table. lock_timeout bounds that wait to 5 s per statement
-- and statement_timeout bounds any single statement to 60 s; on timeout the
-- statement errors, Prisma rolls the whole migration back (it runs each
-- migration.sql in one transaction on PostgreSQL), _prisma_migrations records
-- the failure, and `prisma migrate deploy` can simply be re-run after
-- `prisma migrate resolve --rolled-back 20261224000000_rls_close_public_exposure`.
-- Session-level SET (not SET LOCAL) so the bounds also hold if a future tool
-- runs this file outside a transaction; they die with the migration session.
--
-- IDEMPOTENT: every statement is safe to re-run (IF EXISTS / OR REPLACE /
-- idempotent ALTER/REVOKE), which is the documented recovery path when the
-- SQL has been reversed out-of-band but _prisma_migrations still says applied
-- (see the INVARIANT note at the bottom).

SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- =====================================================================
-- 1) 14 server-only tables: ENABLE + FORCE RLS, service_role bypass policy,
--    RESTRICTIVE deny-all for anon/authenticated, REVOKE API-role grants.
-- =====================================================================
DO $s1$
DECLARE
  t text;
  tables text[] := ARRAY[
    'ClientAssetGrant', 'CoachMediaAsset', 'CoachPackageContent',
    'DripResolverMarker', 'DunningAttempt', 'MuxProcessedEvent', 'NudgeLog',
    'PaymentRecoveryToken', 'PayoutMethod', 'PurchaseFanout', 'ScheduledDrop',
    'UserAIQuota', 'coach_ltv_peak', 'recent_auth_nonce'
  ];
  api_roles_present boolean;
BEGIN
  SELECT count(*) = 3 INTO api_roles_present
  FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role');
  IF NOT api_roles_present THEN
    RAISE EXCEPTION 'S1-DB-01: Supabase API roles (anon/authenticated/service_role) are missing; apply scripts/ci/supabase-shim.sql on non-Supabase targets first';
  END IF;

  FOREACH t IN ARRAY tables LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      RAISE EXCEPTION 'S1-DB-01: expected table public.% is missing', t;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'p_' || t || '_service_role_all', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true)',
      'p_' || t || '_service_role_all', t);
    EXECUTE format(
      'COMMENT ON POLICY %I ON public.%I IS %L',
      'p_' || t || '_service_role_all', t,
      'Primitive A: service_role bypass (S1-DB-01). Table is reached only by the backend Prisma client.');

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'deny_all_anon_' || t, t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false)',
      'deny_all_anon_' || t, t);
    EXECUTE format(
      'COMMENT ON POLICY %I ON public.%I IS %L',
      'deny_all_anon_' || t, t,
      'RESTRICTIVE deny-all: anon can never read/write this server-only table (S1-DB-01).');

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'deny_all_authenticated_' || t, t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false)',
      'deny_all_authenticated_' || t, t);
    EXECUTE format(
      'COMMENT ON POLICY %I ON public.%I IS %L',
      'deny_all_authenticated_' || t, t,
      'RESTRICTIVE deny-all: authenticated principals can never read/write this server-only table (S1-DB-01).');

    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM anon, authenticated', t);
  END LOOP;
END
$s1$;

-- =====================================================================
-- 2) community_messages partitions — current AND future.
--
-- Rows read/written THROUGH the parent are governed by the parent's policies
-- (PostgreSQL applies the policies of the relation named in the query, and
-- tuple routing does not re-check partition policies). A partition accessed
-- DIRECTLY is governed only by its own relrowsecurity/policies. So each
-- partition gets RLS enabled + forced with NO permissive policy for the API
-- roles (deny-by-default on direct access), an explicit service_role policy,
-- and its API-role grants revoked. BYPASSRLS roles and the parent path are
-- unaffected — proven by test/db/s1-rls-close-public-exposure.spec.ts.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.community_messages_protect_partition(p_partition regclass)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_name text := (SELECT c.relname FROM pg_catalog.pg_class c WHERE c.oid = p_partition);
BEGIN
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'community_messages_protect_partition: relation % does not exist', p_partition;
  END IF;
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_name);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', v_name);
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'p_' || v_name || '_service_role_all', v_name);
  EXECUTE format(
    'CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true)',
    'p_' || v_name || '_service_role_all', v_name);
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'deny_all_anon_' || v_name, v_name);
  EXECUTE format(
    'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false)',
    'deny_all_anon_' || v_name, v_name);
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'deny_all_authenticated_' || v_name, v_name);
  EXECUTE format(
    'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false)',
    'deny_all_authenticated_' || v_name, v_name);
  EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM anon, authenticated', v_name);
END
$fn$;

COMMENT ON FUNCTION public.community_messages_protect_partition(regclass) IS
  'S1-DB-01: enables+forces RLS, installs service_role/deny-all policies and revokes anon/authenticated grants on one community_messages partition. Idempotent. Called for every existing partition and by community_messages_create_month_partition().';

REVOKE ALL ON FUNCTION public.community_messages_protect_partition(regclass) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.community_messages_protect_partition(regclass) TO service_role;

-- Re-create the month-partition helper so FUTURE partitions are protected at
-- creation time, and pin its search_path (advisor: function_search_path_mutable).
-- Signature unchanged -> OR REPLACE keeps the OID and any dependents.
CREATE OR REPLACE FUNCTION public.community_messages_create_month_partition(p_month DATE)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_start DATE := date_trunc('month', p_month)::date;
  v_end   DATE := (date_trunc('month', p_month) + INTERVAL '1 month')::date;
  v_name  TEXT := 'community_messages_' || to_char(v_start, 'YYYY_MM');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public."community_messages" FOR VALUES FROM (%L) TO (%L)',
    v_name, v_start, v_end
  );
  PERFORM public.community_messages_protect_partition(format('public.%I', v_name)::regclass);
  RETURN v_name;
END;
$fn$;

COMMENT ON FUNCTION public.community_messages_create_month_partition(DATE) IS
  'Idempotently provisions the monthly community_messages partition covering p_month AND protects it (RLS enabled+forced, deny-all anon/authenticated, service_role bypass, API grants revoked). search_path pinned (S1-DB-01). Parent RLS does NOT propagate to partitions on its own.';

REVOKE ALL ON FUNCTION public.community_messages_create_month_partition(DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.community_messages_create_month_partition(DATE) TO service_role;

-- Protect every partition that exists right now (the four observed ones plus
-- any provisioned since), discovered from the catalog rather than hard-coded.
DO $s1$
DECLARE
  part regclass;
BEGIN
  FOR part IN
    SELECT i.inhrelid::regclass
    FROM pg_inherits i
    WHERE i.inhparent = 'public.community_messages'::regclass
  LOOP
    PERFORM public.community_messages_protect_partition(part);
  END LOOP;
END
$s1$;

-- =====================================================================
-- 3) app.* community helpers — pin search_path (advisor:
--    function_search_path_mutable). Bodies unchanged except every reference
--    is schema-qualified so an empty search_path resolves them. Signatures
--    unchanged -> OR REPLACE keeps OIDs; the policies that call them keep
--    working. EXECUTE grants are untouched (the community policies are
--    `TO public` and evaluate these helpers for anon/authenticated).
-- =====================================================================
CREATE OR REPLACE FUNCTION app.is_community_workspace_coach(p_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public."community_workspaces" w
    WHERE w."id" = p_workspace_id
      AND w."coach_id"::text = app.current_user_id()
  )
$fn$;

CREATE OR REPLACE FUNCTION app.is_community_workspace_member(p_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public."community_memberships" m
    WHERE m."workspace_id" = p_workspace_id
      AND m."user_id"::text = app.current_user_id()
      AND m."status" <> 'removed'
  )
$fn$;

CREATE OR REPLACE FUNCTION app.shares_community_cohort(p_cohort_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public."community_memberships" m
    WHERE m."cohort_id" = p_cohort_id
      AND m."user_id"::text = app.current_user_id()
      AND m."status" <> 'removed'
  )
$fn$;

COMMENT ON FUNCTION app.is_community_workspace_coach(uuid) IS
  'Caller owns the community workspace. search_path pinned to '''' (S1-DB-01).';
COMMENT ON FUNCTION app.is_community_workspace_member(uuid) IS
  'Caller holds a non-removed membership in the workspace. search_path pinned to '''' (S1-DB-01).';
COMMENT ON FUNCTION app.shares_community_cohort(uuid) IS
  'Caller shares the cohort via a non-removed membership. search_path pinned to '''' (S1-DB-01).';

-- =====================================================================
-- INVARIANT (S1-DB-01, recorded from the prior recovery finding): once this
-- migration row is marked applied, `prisma migrate status` / `migrate deploy`
-- report "up to date" from _prisma_migrations ALONE. If the DDL above is later
-- reversed out-of-band (rollback.sql, manual psql, restore of an older dump),
-- Prisma keeps saying "up to date" and `prisma migrate resolve --rolled-back`
-- REFUSES because the row is not in a failed state. The only truthful check is
-- the catalog itself: run prisma/migrations/20261224000000_rls_close_public_exposure/verify.sql
-- (exit non-zero on any drift) after every deploy and after any restore.
-- =====================================================================
