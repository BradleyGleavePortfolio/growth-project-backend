-- RLSLIVE3b (RLSINV M01-M05, Y02; owner "RLS for everything!", "Billing works
-- robustly"): money rows are written by the server only. People read their
-- own purchases, refunds, Stripe mirrors, packages and contract envelopes, and
-- write none of them at the row layer. Policy text and comments only: no data,
-- grant, helper or table change.
--
-- GAP (production catalog of 2026-10-13; four of these policies exist only
-- there, never in the migration chain, so they are dropped IF EXISTS):
--   * ClientPurchase: client_purchase_client_or_coach_access (FOR ALL, client
--     or seller coach; production only) and client_purchase_insert let the
--     client and the coach insert, rewrite and delete purchases (M01).
--   * ChargeRefund: p_chargerefund_insert/_update/_delete let either party to
--     a purchase write its refund mirror (M02).
--   * connect_customer_client_owner_access, connect_account_coach_owner_access
--     (production only) and coach_subscription_owner_access: FOR ALL on the
--     row's subject, so a client rewrote their Stripe customer mirror and a
--     coach their Connect account and SaaS subscription rows (M03).
--   * CoachPackage: coach_package_coach_all (FOR ALL, no WITH CHECK, Y02) and
--     coach_package_owner_access (FOR ALL, production only): the coach wrote
--     price and Stripe ids directly.
--   * AICallLog: a participant inserted cost rows naming any coach, and the
--     client read the coach's per-call AI cost (M04).
--   * ContractEnvelope: insert/update keyed on coach_id alone, so a coach
--     created envelopes for another coach's client and a former coach kept
--     writing a moved client's envelopes (M05).
--
-- NOW:
--   * ClientPurchase, ConnectCustomer, ConnectAccount: only their existing
--     SELECT policies remain (client_purchase_select, connect_customer_select,
--     connect_account_select).
--   * ChargeRefund: p_chargerefund_select only (a party to the purchase, or
--     the owner admin), so the former coach still reads refunds on their sale.
--   * CoachSubscription, CoachPackage: one SELECT policy each, the row's coach.
--   * AICallLog: read by the row's coach only; no INSERT policy.
--   * ContractEnvelope: insert and update need coach_id = caller AND the
--     caller coaching the envelope's client now (app.is_current_coach_of);
--     owner admin unchanged; p_contractenvelope_select unchanged.
-- Unchanged: every *_server_only policy (permissive USING false, a no-op; kept
-- to keep this diff small), every *_owner_all and *_service_role_all policy.
--
-- Nothing in the app depends on a dropped or narrowed branch: Prisma connects
-- as service_role (BYPASSRLS) and every read and write of these tables in
-- src/ is a Prisma call, src/ sets no role and has no Supabase client on a
-- table, and the mobile app reads no table through the Supabase Data API.
-- Reverse: down.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP POLICY IF EXISTS "client_purchase_client_or_coach_access" ON "ClientPurchase";
DROP POLICY IF EXISTS "client_purchase_insert" ON "ClientPurchase";

DROP POLICY IF EXISTS "p_chargerefund_insert" ON "ChargeRefund";
DROP POLICY IF EXISTS "p_chargerefund_update" ON "ChargeRefund";
DROP POLICY IF EXISTS "p_chargerefund_delete" ON "ChargeRefund";

DROP POLICY IF EXISTS "connect_customer_client_owner_access" ON "ConnectCustomer";
DROP POLICY IF EXISTS "connect_account_coach_owner_access" ON "ConnectAccount";

DROP POLICY IF EXISTS "coach_subscription_owner_access" ON "CoachSubscription";
CREATE POLICY "coach_subscription_owner_select" ON "CoachSubscription"
  FOR SELECT TO public
  USING (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id());
COMMENT ON POLICY "coach_subscription_owner_select" ON "CoachSubscription" IS
  'RLSLIVE3b: the coach reads their own subscription row. Written by the server (Stripe webhooks) only.';

DROP POLICY IF EXISTS "coach_package_owner_access" ON "CoachPackage";
DROP POLICY IF EXISTS "coach_package_coach_all" ON "CoachPackage";
CREATE POLICY "coach_package_coach_select" ON "CoachPackage"
  FOR SELECT TO public
  USING (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id());
COMMENT ON POLICY "coach_package_coach_select" ON "CoachPackage" IS
  'RLSLIVE3b: the coach reads their own packages. Written by the server (PackagesService) only.';

DROP POLICY IF EXISTS "ai_call_log_participant_insert" ON "AICallLog";
ALTER POLICY "ai_call_log_participant_select" ON "AICallLog"
  USING (app.current_user_id() IS NOT NULL AND "coachId" = app.current_user_id());
COMMENT ON POLICY "ai_call_log_participant_select" ON "AICallLog" IS
  'RLSLIVE3b: AI cost rows are read by their coach only (owner admin: ai_call_log_owner_all). Written by the server only.';

ALTER POLICY "p_contractenvelope_insert" ON "ContractEnvelope"
  WITH CHECK ((app.is_owner() OR ("coach_id" = app.current_user_id() AND app.is_current_coach_of("client_id"))));
COMMENT ON POLICY "p_contractenvelope_insert" ON "ContractEnvelope" IS
  'RLSLIVE3b: owner, or the coach (coach_id = self) who coaches the envelope''s client now, may INSERT. Clients never create envelopes directly.';
ALTER POLICY "p_contractenvelope_update" ON "ContractEnvelope"
  USING ((app.is_owner() OR ("coach_id" = app.current_user_id() AND app.is_current_coach_of("client_id"))))
  WITH CHECK ((app.is_owner() OR ("coach_id" = app.current_user_id() AND app.is_current_coach_of("client_id"))));
COMMENT ON POLICY "p_contractenvelope_update" ON "ContractEnvelope" IS
  'RLSLIVE3b: owner, or the owning coach while they coach the envelope''s client, may UPDATE; a former coach may not. Status advances from provider events run as service_role.';

COMMIT;
