-- BILLRAW (agent 151; OWN-PR-B1 of the b#988 review; owner "RLS for
-- everything!" and "Billing works robustly"): billing rows are server-only.
-- The Data API roles lose every right on the 20 billing tables whose row rules
-- let a signed-in party read raw rows.
--
-- GAP: each table below keeps a permissive row rule for the row's party
--   (seller, buyer, payee or subject), and the grant floor (20270502001000)
--   left SELECT with anon and authenticated (INSERT, UPDATE and DELETE too
--   with authenticated). So a session as authenticated with
--   app.current_user_id naming a coach read that coach's raw ClientPurchase
--   rows (the client's stripe_client_secret and stripe_ephemeral_key, access,
--   card and trial state) and the refunds, disputes, settlements, transfers
--   and payout rows hanging off them, also after the client had moved to
--   another coach (client_purchase_select, 20260606000003, checks only the
--   seller). The server's allow-listed projections
--   (src/checkout/coach-payments.select.ts and its peers) never applied there.
-- NOW: REVOKE ALL on the 20 tables from PUBLIC, anon and authenticated.
--   service_role and the owner keep theirs. The row rules stay as they are;
--   no API role reaches them. Nothing reads these tables directly: the server
--   connects with a role that bypasses row security and src/ sets no role,
--   and the mobile app (main 99e5d659) reads no table through the Data API
--   (its Supabase clients do sign-in and realtime broadcast only), so no
--   own-money projection is kept.
-- REACH: no Data API request sets app.current_user_id today, so the row rules
--   admitted a party only on a connection that sets it as authenticated (the
--   model every live RLS suite uses). The grant layer now refuses both.
-- ROLLBACK: every grant removed (table and column level, with grant option)
--   is recorded first in app.billing_api_grant_backup; down.sql re-grants
--   exactly those rows and drops the table (RLS on and forced, no policy, no
--   API grant). The migration aborts if anon or authenticated can still use a
--   listed table.
-- Live proof: test/rls/billing-rows-server-only-rls.spec.ts (rls-live-tests).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE app.billing_api_grant_backup (
  target    text    NOT NULL,
  col       text    NOT NULL DEFAULT '',
  grantee   text    NOT NULL,
  privilege text    NOT NULL,
  grantable boolean NOT NULL DEFAULT false,
  PRIMARY KEY (target, col, grantee, privilege)
);

DO $$
DECLARE
  names text[] := ARRAY['ClientPurchase', 'ChargeRefund', 'ChargeDispute', 'PartialRefundDecision',
    'ReconciliationSnapshot', 'ChargeSettlement', 'SplitLedgerEntry', 'ConnectTransfer', 'PayoutAdjustmentNotice',
    'PayeeRecovery', 'PayoutSnapshot', 'ConnectAccount', 'ConnectCustomer', 'Invoice', 'CoachSubscription',
    'PaymentFailure', 'CoachCreditPackPurchase', 'PackageTrialUsage', 'PackageTrialNotice',
    'coach_first_payment_notification'];
  left_over text;
BEGIN
  INSERT INTO app.billing_api_grant_backup
  SELECT format('public.%I', c.relname), x.col,
         CASE WHEN a.grantee = 0::oid THEN 'PUBLIC' ELSE a.grantee::regrole::text END, a.privilege_type, bool_or(a.is_grantable)
    FROM pg_class c
   CROSS JOIN LATERAL (SELECT '' AS col, c.relacl AS acl
                       UNION ALL
                       SELECT quote_ident(att.attname), att.attacl FROM pg_attribute att
                        WHERE att.attrelid = c.oid AND att.attnum > 0 AND NOT att.attisdropped) x
   CROSS JOIN LATERAL aclexplode(x.acl) a
   WHERE c.oid = ANY (ARRAY(SELECT format('public.%I', n)::regclass::oid FROM unnest(names) n))
     AND a.grantee IN (0::oid, 'anon'::regrole::oid, 'authenticated'::regrole::oid)
   GROUP BY 1, 2, 3, 4;

  EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC, anon, authenticated',
    (SELECT string_agg(format('public.%I', n), ', ') FROM unnest(names) n));

  SELECT string_agg(r || ' ' || n, ', ' ORDER BY n, r) INTO left_over
    FROM unnest(names) n CROSS JOIN unnest(ARRAY['anon', 'authenticated']) r
   WHERE has_table_privilege(r, format('public.%I', n), 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
      OR has_any_column_privilege(r, format('public.%I', n), 'SELECT, INSERT, UPDATE, REFERENCES');
  IF left_over IS NOT NULL THEN
    RAISE EXCEPTION 'billing_rows_server_only: still usable by an API role: %', left_over;
  END IF;
END
$$;

REVOKE ALL ON TABLE app.billing_api_grant_backup FROM PUBLIC, anon, authenticated;
ALTER TABLE app.billing_api_grant_backup ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.billing_api_grant_backup FORCE ROW LEVEL SECURITY;

COMMIT;
