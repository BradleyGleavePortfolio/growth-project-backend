-- S1-DB-01 operator rollback (NOT run by Prisma; forward-only history stands).
--
-- Restores the pre-migration authorization state of the 18 relations and the
-- three app.* helpers EXACTLY: RLS disabled, no policies, anon/authenticated
-- ALL grants back (this is what Supabase default privileges had produced).
-- The partition helper keeps protecting new partitions? NO — to be a true
-- reverse it is restored to the original unpinned body as well.
--
-- !! READ BEFORE USING !!
-- After running this, `prisma migrate status` STILL prints "Database schema is
-- up to date!" because _prisma_migrations still holds the applied row, and
-- `prisma migrate resolve --rolled-back 20261224000000_rls_close_public_exposure`
-- FAILS with P3012 ("not in a failed state"). That false "up to date" is the
-- documented prior-audit finding. Consequences:
--   * verify.sql is the only truthful signal (it FAILS after this script);
--   * to re-apply, run migration.sql again directly (it is idempotent) — do
--     NOT delete the _prisma_migrations row to make Prisma re-run it unless
--     you also accept re-running under a fresh checksum audit.
-- Same lock/timeout bounds as the forward migration.

SET lock_timeout = '5s';
SET statement_timeout = '60s';

DO $rb$
DECLARE
  t text;
  rels text[];
BEGIN
  SELECT ARRAY[
    'ClientAssetGrant', 'CoachMediaAsset', 'CoachPackageContent',
    'DripResolverMarker', 'DunningAttempt', 'MuxProcessedEvent', 'NudgeLog',
    'PaymentRecoveryToken', 'PayoutMethod', 'PurchaseFanout', 'ScheduledDrop',
    'UserAIQuota', 'coach_ltv_peak', 'recent_auth_nonce'
  ] || COALESCE(array_agg(c.relname::text), ARRAY[]::text[])
  INTO rels
  FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
  WHERE i.inhparent = to_regclass('public.community_messages');

  FOREACH t IN ARRAY rels LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'p_' || t || '_service_role_all', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'deny_all_anon_' || t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'deny_all_authenticated_' || t, t);
    EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE public.%I TO anon, authenticated', t);
  END LOOP;
END
$rb$;

DROP FUNCTION IF EXISTS public.community_messages_protect_partition(regclass);

CREATE OR REPLACE FUNCTION public.community_messages_create_month_partition(p_month DATE)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_start DATE := date_trunc('month', p_month)::date;
  v_end   DATE := (date_trunc('month', p_month) + INTERVAL '1 month')::date;
  v_name  TEXT := 'community_messages_' || to_char(v_start, 'YYYY_MM');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF "community_messages" FOR VALUES FROM (%L) TO (%L)',
    v_name, v_start, v_end
  );
  RETURN v_name;
END;
$$;
ALTER FUNCTION public.community_messages_create_month_partition(DATE) RESET search_path;
GRANT EXECUTE ON FUNCTION public.community_messages_create_month_partition(DATE) TO PUBLIC;

ALTER FUNCTION app.is_community_workspace_coach(uuid) RESET search_path;
ALTER FUNCTION app.is_community_workspace_member(uuid) RESET search_path;
ALTER FUNCTION app.shares_community_cohort(uuid) RESET search_path;
