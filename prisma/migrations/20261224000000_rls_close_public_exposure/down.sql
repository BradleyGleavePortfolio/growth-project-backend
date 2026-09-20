-- S1-DB-01 operator reverse (down.sql per the repo reversibility gate; NOT run
-- by Prisma — the forward-only history stands).
--
-- Restores the pre-migration authorization state of the 18 relations and the
-- helpers: RLS disabled, no policies, anon/authenticated ALL grants back
-- (what Supabase default privileges had produced), original unpinned function
-- bodies for the partition helper and the three app.* helpers. Known
-- difference from the literal pre-state, behaviour-neutral: any partition
-- created AFTER the forward migration receives the same anon/authenticated
-- grants the older ones had (that is what default privileges would have done).
--
-- Run as the migration role with: psql --single-transaction -v ON_ERROR_STOP=1 -f down.sql
--
-- !! READ BEFORE USING !!
-- After running this, `prisma migrate status` STILL prints "Database schema is
-- up to date!" because _prisma_migrations still holds the applied row. The
-- documented prior-audit finding: `prisma migrate resolve --rolled-back
-- 20261224000000_rls_close_public_exposure` does NOT recover this state — with
-- a clean history it fails (P3012, not in a failed state); if an earlier
-- failed attempt exists it prints "marked as rolled back" and changes nothing
-- about the applied row (both observed by test/db/s1-rls-close-public-exposure.sh).
-- Consequences:
--   * verify.sql is the only truthful signal (it FAILS after this script);
--   * to re-apply, run migration.sql again directly with
--     psql --single-transaction -v ON_ERROR_STOP=1 (it is idempotent) — do
--     NOT delete or edit the _prisma_migrations row to make Prisma re-run it.
-- Same lock/timeout bounds as the forward migration (RESET at the end).

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
COMMENT ON FUNCTION public.community_messages_create_month_partition(DATE) IS
  'Idempotently provisions the monthly community_messages partition covering p_month; called by the monthly partition ops job. Inherited indexes + parent RLS apply automatically.';

-- Original (20261212000000_community_v1_1_schema) bodies, unpinned, no comments.
CREATE OR REPLACE FUNCTION app.is_community_workspace_coach(p_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM "community_workspaces" w
    WHERE w."id" = p_workspace_id
      AND w."coach_id"::text = app.current_user_id()
  )
$$;

CREATE OR REPLACE FUNCTION app.is_community_workspace_member(p_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM "community_memberships" m
    WHERE m."workspace_id" = p_workspace_id
      AND m."user_id"::text = app.current_user_id()
      AND m."status" <> 'removed'
  )
$$;

CREATE OR REPLACE FUNCTION app.shares_community_cohort(p_cohort_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM "community_memberships" m
    WHERE m."cohort_id" = p_cohort_id
      AND m."user_id"::text = app.current_user_id()
      AND m."status" <> 'removed'
  )
$$;

ALTER FUNCTION app.is_community_workspace_coach(uuid) RESET search_path;
ALTER FUNCTION app.is_community_workspace_member(uuid) RESET search_path;
ALTER FUNCTION app.shares_community_cohort(uuid) RESET search_path;
COMMENT ON FUNCTION app.is_community_workspace_coach(uuid) IS NULL;
COMMENT ON FUNCTION app.is_community_workspace_member(uuid) IS NULL;
COMMENT ON FUNCTION app.shares_community_cohort(uuid) IS NULL;

RESET lock_timeout;
RESET statement_timeout;
