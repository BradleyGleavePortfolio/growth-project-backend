-- Reverse of 20270502000300_money_rows_are_server_written. Only for a
-- confirmed defect: it reopens M01-M05 (clients and coaches write purchases,
-- refunds, Stripe mirrors, packages, AI cost rows and contract envelopes at
-- the row layer). Restores the production text of 2026-10-13 exactly: the
-- chain's policies with the text and comments of 20260606000003,
-- 20260607000000, 20261213000000, 20261215000200 and 20270410000000, plus the
-- four policies that exist only in production (client_purchase_client_or_
-- coach_access, connect_customer_client_owner_access, connect_account_coach_
-- owner_access, coach_package_owner_access; the catalog shows no comment on
-- them). On a database built from the chain alone those four are added too.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER POLICY "p_contractenvelope_update" ON "ContractEnvelope"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())))
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_contractenvelope_update" ON "ContractEnvelope" IS 'Update: owner or owning coach (coach_id) may UPDATE; CHECK prevents re-owning to another coach_id. Status advances from provider events run as service_role.';
ALTER POLICY "p_contractenvelope_insert" ON "ContractEnvelope"
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_contractenvelope_insert" ON "ContractEnvelope" IS 'Write: only owner or the owning coach (coach_id = self) may INSERT an envelope. Clients never create envelopes directly; sub-coaches get SELECT only.';

ALTER POLICY "ai_call_log_participant_select" ON "AICallLog"
  USING (app.current_user_id() IS NOT NULL AND ("coachId" = app.current_user_id() OR "clientId" = app.current_user_id()));
COMMENT ON POLICY "ai_call_log_participant_select" ON "AICallLog" IS NULL;
CREATE POLICY "ai_call_log_participant_insert" ON "AICallLog"
  FOR INSERT TO public
  WITH CHECK (app.current_user_id() IS NOT NULL AND ("coachId" = app.current_user_id() OR "clientId" = app.current_user_id()));

DROP POLICY "coach_package_coach_select" ON "CoachPackage";
CREATE POLICY "coach_package_coach_all" ON "CoachPackage"
  FOR ALL USING (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id());
CREATE POLICY "coach_package_owner_access" ON "CoachPackage"
  FOR ALL TO public USING ("coach_id" = app.current_user_id()) WITH CHECK ("coach_id" = app.current_user_id());

DROP POLICY "coach_subscription_owner_select" ON "CoachSubscription";
CREATE POLICY "coach_subscription_owner_access" ON "CoachSubscription"
  FOR ALL TO public USING ("coach_id" = app.current_user_id()) WITH CHECK ("coach_id" = app.current_user_id());

CREATE POLICY "connect_account_coach_owner_access" ON "ConnectAccount"
  FOR ALL TO public USING ("coach_user_id" = app.current_user_id()) WITH CHECK ("coach_user_id" = app.current_user_id());
CREATE POLICY "connect_customer_client_owner_access" ON "ConnectCustomer"
  FOR ALL TO public USING ("client_user_id" = app.current_user_id()) WITH CHECK ("client_user_id" = app.current_user_id());

CREATE POLICY "p_chargerefund_insert" ON "ChargeRefund" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."ClientPurchase" cp WHERE cp."id" = "ChargeRefund"."purchase_id" AND (cp."client_user_id" = app.current_user_id() OR cp."coach_user_id" = app.current_user_id())))));
COMMENT ON POLICY "p_chargerefund_insert" ON "ChargeRefund" IS 'A party to the purchase (coach-initiated refund) or an owner may record a refund; service role covers webhook rows.';
CREATE POLICY "p_chargerefund_update" ON "ChargeRefund" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."ClientPurchase" cp WHERE cp."id" = "ChargeRefund"."purchase_id" AND (cp."client_user_id" = app.current_user_id() OR cp."coach_user_id" = app.current_user_id()))))) WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."ClientPurchase" cp WHERE cp."id" = "ChargeRefund"."purchase_id" AND (cp."client_user_id" = app.current_user_id() OR cp."coach_user_id" = app.current_user_id())))));
COMMENT ON POLICY "p_chargerefund_update" ON "ChargeRefund" IS 'A party to the purchase or an owner may amend a refund row; service role covers webhook updates.';
CREATE POLICY "p_chargerefund_delete" ON "ChargeRefund" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."ClientPurchase" cp WHERE cp."id" = "ChargeRefund"."purchase_id" AND (cp."client_user_id" = app.current_user_id() OR cp."coach_user_id" = app.current_user_id())))));
COMMENT ON POLICY "p_chargerefund_delete" ON "ChargeRefund" IS 'Only a party to the purchase, an owner, or service role may delete a refund record.';

CREATE POLICY "client_purchase_insert" ON "ClientPurchase"
  FOR INSERT WITH CHECK (app.current_user_id() IS NOT NULL AND "coach_user_id" = app.current_user_id());
CREATE POLICY "client_purchase_client_or_coach_access" ON "ClientPurchase"
  FOR ALL TO public
  USING ("client_user_id" = app.current_user_id() OR "coach_user_id" = app.current_user_id())
  WITH CHECK ("client_user_id" = app.current_user_id() OR "coach_user_id" = app.current_user_id());

COMMIT;
