-- S-FEE — per-charge settlement ledger for coach-package payments.
--
-- Additive except for one index swap on SplitLedgerEntry:
--   * new tables ChargeSettlement, PayeeRecovery, TransferReversalOp, CronLease,
--     PayoutAdjustmentNotice (RLS enabled + forced);
--   * ConnectTransfer gains settlement_id / kind / netted_recovery_cents /
--     reversal_seq / stripe_send_unresolved_at
--     (defaults keep every existing row valid: kind='head_coach_split');
--   * SplitLedgerEntry's (purchase_id, kind, payee_user_id) unique is replaced
--     by (purchase_id, kind, payee_user_id, stripe_charge_id) so each renewal
--     charge gets its own ledger rows. The new key is strictly weaker than the
--     old one, so every existing row already satisfies it (no data rewrite).
--
-- RLS posture mirrors SplitLedgerEntry / ConnectTransfer
-- (20260607000000_rls_remaining_gaps): owner ALL, payee SELECT, service_role
-- (Primitive A) for the webhook/settlement writers. anon resolves to zero rows.
--
-- Rollback: down.sql (refuses once any settlement row exists; forward-fix only).

BEGIN;

-- ConnectTransfer: settlement linkage.
ALTER TABLE "ConnectTransfer" ADD COLUMN "settlement_id" TEXT;
ALTER TABLE "ConnectTransfer" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'head_coach_split';
ALTER TABLE "ConnectTransfer" ADD COLUMN "netted_recovery_cents" INTEGER NOT NULL DEFAULT 0;
-- Round 4: reversal operation slot (B-627-5).
ALTER TABLE "ConnectTransfer" ADD COLUMN "reversal_seq" INTEGER NOT NULL DEFAULT 0;
-- Round 7 (B-627-8): set before every Stripe create, cleared when its result
-- is established. While set, the transfer is reconciled against Stripe's
-- transfer list before anything is sent again (Stripe idempotency keys can
-- expire after 24 h). Existing pending rows that were already tried once are
-- treated as unresolved, so a lost earlier result is looked up, not re-sent.
ALTER TABLE "ConnectTransfer" ADD COLUMN "stripe_send_unresolved_at" TIMESTAMP(3);
UPDATE "ConnectTransfer"
   SET "stripe_send_unresolved_at" = COALESCE("last_attempt_at", "updated_at")
 WHERE "status" = 'pending' AND "attempts" > 0 AND "stripe_transfer_id" IS NULL;

-- SplitLedgerEntry: per-charge uniqueness. The old 3-column unique is named
-- "SplitLedgerEntry_purchase_kind_payee_idx" by the migration chain
-- (20260602000000) and "SplitLedgerEntry_purchase_id_kind_payee_user_id_key"
-- by Prisma's default naming; drop whichever exists. The new name is mapped
-- explicitly in schema.prisma because Prisma's default would exceed 63 chars.
DROP INDEX IF EXISTS "SplitLedgerEntry_purchase_kind_payee_idx";
DROP INDEX IF EXISTS "SplitLedgerEntry_purchase_id_kind_payee_user_id_key";
CREATE UNIQUE INDEX "SplitLedgerEntry_purchase_kind_payee_charge_key"
  ON "SplitLedgerEntry"("purchase_id", "kind", "payee_user_id", "stripe_charge_id");
CREATE INDEX "SplitLedgerEntry_stripe_charge_id_idx" ON "SplitLedgerEntry"("stripe_charge_id");

-- ChargeSettlement.
CREATE TABLE "ChargeSettlement" (
    "id" TEXT NOT NULL,
    "purchase_id" TEXT NOT NULL,
    "coach_user_id" TEXT NOT NULL,
    "head_coach_user_id" TEXT,
    "stripe_charge_id" TEXT NOT NULL,
    "stripe_balance_transaction_id" TEXT,
    "stripe_invoice_id" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "rail" TEXT NOT NULL DEFAULT 'card',
    "mechanism" TEXT NOT NULL DEFAULT 'separate_charge_transfer',
    "status" TEXT NOT NULL DEFAULT 'awaiting_fee',
    "platform_bps" INTEGER NOT NULL,
    "head_coach_bps" INTEGER NOT NULL DEFAULT 0,
    "gross_cents" INTEGER NOT NULL,
    "stripe_fee_cents" INTEGER,
    "platform_fee_cents" INTEGER,
    "head_coach_split_cents" INTEGER,
    "coach_net_cents" INTEGER,
    "refunded_cents" INTEGER NOT NULL DEFAULT 0,
    "dispute_withdrawn_cents" INTEGER NOT NULL DEFAULT 0,
    "dispute_fee_cents" INTEGER NOT NULL DEFAULT 0,
    "target_platform_fee_cents" INTEGER,
    "target_head_coach_cents" INTEGER,
    "target_coach_net_cents" INTEGER,
    "settled_at" TIMESTAMP(3),
    "adjusted_at" TIMESTAMP(3),
    "last_error" TEXT,
    "reconcile_requested_at" TIMESTAMP(3),
    "reconcile_dispute_id" TEXT,
    "reconcile_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ChargeSettlement_pkey" PRIMARY KEY ("id"),
    -- Money invariants enforced by the database as well as the service.
    CONSTRAINT "ChargeSettlement_gross_nonneg" CHECK ("gross_cents" >= 0),
    CONSTRAINT "ChargeSettlement_platform_fee_nonneg" CHECK ("platform_fee_cents" IS NULL OR "platform_fee_cents" >= 0),
    CONSTRAINT "ChargeSettlement_target_platform_fee_nonneg" CHECK ("target_platform_fee_cents" IS NULL OR "target_platform_fee_cents" >= 0),
    CONSTRAINT "ChargeSettlement_slices_sum_to_gross" CHECK (
      "status" <> 'settled' OR (
        "stripe_fee_cents" + "platform_fee_cents" + "head_coach_split_cents" + "coach_net_cents" = "gross_cents"
      )
    )
);
CREATE UNIQUE INDEX "ChargeSettlement_stripe_charge_id_key" ON "ChargeSettlement"("stripe_charge_id");
CREATE INDEX "ChargeSettlement_purchase_id_idx" ON "ChargeSettlement"("purchase_id");
CREATE INDEX "ChargeSettlement_coach_user_id_created_at_idx" ON "ChargeSettlement"("coach_user_id", "created_at");
CREATE INDEX "ChargeSettlement_status_idx" ON "ChargeSettlement"("status");
CREATE INDEX "ChargeSettlement_reconcile_requested_at_idx" ON "ChargeSettlement"("reconcile_requested_at");
ALTER TABLE "ChargeSettlement" ADD CONSTRAINT "ChargeSettlement_purchase_id_fkey"
  FOREIGN KEY ("purchase_id") REFERENCES "ClientPurchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- PayeeRecovery.
CREATE TABLE "PayeeRecovery" (
    "id" TEXT NOT NULL,
    "settlement_id" TEXT NOT NULL,
    "payee_user_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "collected_cents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "idempotency_key" TEXT NOT NULL,
    "collected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PayeeRecovery_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PayeeRecovery_amount_nonneg" CHECK ("amount_cents" >= 0),
    CONSTRAINT "PayeeRecovery_collected_bounded" CHECK ("collected_cents" >= 0 AND "collected_cents" <= "amount_cents")
);
CREATE UNIQUE INDEX "PayeeRecovery_idempotency_key_key" ON "PayeeRecovery"("idempotency_key");
CREATE INDEX "PayeeRecovery_payee_user_id_status_idx" ON "PayeeRecovery"("payee_user_id", "status");
CREATE INDEX "PayeeRecovery_settlement_id_idx" ON "PayeeRecovery"("settlement_id");
ALTER TABLE "PayeeRecovery" ADD CONSTRAINT "PayeeRecovery_settlement_id_fkey"
  FOREIGN KEY ("settlement_id") REFERENCES "ChargeSettlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "ConnectTransfer_settlement_id_idx" ON "ConnectTransfer"("settlement_id");
ALTER TABLE "ConnectTransfer" ADD CONSTRAINT "ConnectTransfer_settlement_id_fkey"
  FOREIGN KEY ("settlement_id") REFERENCES "ChargeSettlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- TransferReversalOp: durable keyed Stripe transfer reversals (round 4, B-627-5).
CREATE TABLE "TransferReversalOp" (
    "id" TEXT NOT NULL,
    "transfer_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "base_reversed_cents" INTEGER NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'adjust',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "stripe_reversal_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMP(3),
    "last_error" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TransferReversalOp_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TransferReversalOp_amount_positive" CHECK ("amount_cents" > 0),
    CONSTRAINT "TransferReversalOp_base_nonneg" CHECK ("base_reversed_cents" >= 0)
);
CREATE UNIQUE INDEX "TransferReversalOp_idempotency_key_key" ON "TransferReversalOp"("idempotency_key");
CREATE UNIQUE INDEX "TransferReversalOp_stripe_reversal_id_key" ON "TransferReversalOp"("stripe_reversal_id");
CREATE UNIQUE INDEX "TransferReversalOp_transfer_id_seq_key" ON "TransferReversalOp"("transfer_id", "seq");
CREATE INDEX "TransferReversalOp_status_created_at_idx" ON "TransferReversalOp"("status", "created_at");
ALTER TABLE "TransferReversalOp" ADD CONSTRAINT "TransferReversalOp_transfer_id_fkey"
  FOREIGN KEY ("transfer_id") REFERENCES "ConnectTransfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- PayoutAdjustmentNotice: the payee-facing refund / chargeback record (round 5,
-- owner decision OR-111-1). Amounts are integer cents in the settlement currency.
CREATE TABLE "PayoutAdjustmentNotice" (
    "id" TEXT NOT NULL,
    "settlement_id" TEXT NOT NULL,
    "payee_user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "purchase_id" TEXT NOT NULL,
    "stripe_charge_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "charge_gross_cents" INTEGER NOT NULL,
    "customer_refunded_cents" INTEGER NOT NULL,
    -- Round 13 (B-683-1): the client's own currency and refunded amount when the
    -- charge was presented in another currency than it settled in; else NULL.
    "client_currency" TEXT,
    "client_refunded_cents" INTEGER CHECK ("client_refunded_cents" >= 0),
    "reversed_cents" INTEGER NOT NULL,
    "reinstated_cents" INTEGER NOT NULL DEFAULT 0,
    "held_cents" INTEGER NOT NULL,
    "held_tgp_fee_cents" INTEGER NOT NULL,
    "held_stripe_fee_cents" INTEGER NOT NULL,
    "held_dispute_fee_cents" INTEGER NOT NULL,
    "held_not_reversed_cents" INTEGER NOT NULL,
    "held_open_cents" INTEGER NOT NULL,
    "state_key" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "inapp_status" TEXT NOT NULL DEFAULT 'pending',
    "inapp_notification_id" TEXT,
    "push_notification_id" TEXT,
    "push_status" TEXT NOT NULL DEFAULT 'pending',
    "email_status" TEXT NOT NULL DEFAULT 'pending',
    "email_attempts" INTEGER NOT NULL DEFAULT 0,
    "dispatch_attempts" INTEGER NOT NULL DEFAULT 0,
    "dispatch_claimed_at" TIMESTAMP(3),
    "dispatched_at" TIMESTAMP(3),
    "acknowledged_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PayoutAdjustmentNotice_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PayoutAdjustmentNotice_amounts_nonneg" CHECK (
      "charge_gross_cents" >= 0 AND "customer_refunded_cents" >= 0 AND "reversed_cents" >= 0
      AND "reinstated_cents" >= 0 AND "held_tgp_fee_cents" >= 0 AND "held_stripe_fee_cents" >= 0
      AND "held_dispute_fee_cents" >= 0 AND "held_not_reversed_cents" >= 0
      AND "held_open_cents" >= 0 AND "held_open_cents" <= "held_cents"
    ),
    CONSTRAINT "PayoutAdjustmentNotice_held_parts_sum" CHECK (
      "held_cents" = "held_tgp_fee_cents" + "held_stripe_fee_cents" + "held_dispute_fee_cents" + "held_not_reversed_cents"
    )
);
CREATE UNIQUE INDEX "PayoutAdjustmentNotice_idempotency_key_key" ON "PayoutAdjustmentNotice"("idempotency_key");
CREATE INDEX "PayoutAdjustmentNotice_payee_user_id_created_at_idx" ON "PayoutAdjustmentNotice"("payee_user_id", "created_at");
CREATE INDEX "PayoutAdjustmentNotice_settlement_id_idx" ON "PayoutAdjustmentNotice"("settlement_id");
CREATE INDEX "PayoutAdjustmentNotice_dispatched_at_created_at_idx" ON "PayoutAdjustmentNotice"("dispatched_at", "created_at");
ALTER TABLE "PayoutAdjustmentNotice" ADD CONSTRAINT "PayoutAdjustmentNotice_settlement_id_fkey"
  FOREIGN KEY ("settlement_id") REFERENCES "ChargeSettlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CronLease: single-runner lease for the scheduled settlement sweep, the
-- per-charge money lock (name 'sfee-charge:<charge id>', deleted on release)
-- and the paid-invoice backfill cursor.
CREATE TABLE "CronLease" (
    "name" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "lease_until" TIMESTAMP(3) NOT NULL,
    "acquired_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "cursor" TEXT,
    CONSTRAINT "CronLease_pkey" PRIMARY KEY ("name")
);

-- RLS.
ALTER TABLE "CronLease" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CronLease" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "cron_lease_service_role_all" ON "CronLease";
CREATE POLICY "cron_lease_service_role_all" ON "CronLease"
  AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "cron_lease_owner_all" ON "CronLease";
CREATE POLICY "cron_lease_owner_all" ON "CronLease"
  FOR ALL TO public USING (app.is_owner()) WITH CHECK (app.is_owner());
ALTER TABLE "ChargeSettlement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChargeSettlement" FORCE ROW LEVEL SECURITY;
ALTER TABLE "PayeeRecovery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PayeeRecovery" FORCE ROW LEVEL SECURITY;
ALTER TABLE "TransferReversalOp" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TransferReversalOp" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "transfer_reversal_op_service_role_all" ON "TransferReversalOp";
CREATE POLICY "transfer_reversal_op_service_role_all" ON "TransferReversalOp"
  AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "transfer_reversal_op_owner_all" ON "TransferReversalOp";
CREATE POLICY "transfer_reversal_op_owner_all" ON "TransferReversalOp"
  FOR ALL TO public USING (app.is_owner()) WITH CHECK (app.is_owner());

DROP POLICY IF EXISTS "charge_settlement_service_role_all" ON "ChargeSettlement";
CREATE POLICY "charge_settlement_service_role_all" ON "ChargeSettlement"
  AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "charge_settlement_owner_all" ON "ChargeSettlement";
CREATE POLICY "charge_settlement_owner_all" ON "ChargeSettlement"
  FOR ALL TO public USING (app.is_owner()) WITH CHECK (app.is_owner());
DROP POLICY IF EXISTS "charge_settlement_payee_select" ON "ChargeSettlement";
CREATE POLICY "charge_settlement_payee_select" ON "ChargeSettlement"
  FOR SELECT TO public
  USING (app.current_user_id() IS NOT NULL AND ("coach_user_id" = app.current_user_id() OR "head_coach_user_id" = app.current_user_id()));

DROP POLICY IF EXISTS "payee_recovery_service_role_all" ON "PayeeRecovery";
CREATE POLICY "payee_recovery_service_role_all" ON "PayeeRecovery"
  AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "payee_recovery_owner_all" ON "PayeeRecovery";
CREATE POLICY "payee_recovery_owner_all" ON "PayeeRecovery"
  FOR ALL TO public USING (app.is_owner()) WITH CHECK (app.is_owner());
DROP POLICY IF EXISTS "payee_recovery_payee_select" ON "PayeeRecovery";
CREATE POLICY "payee_recovery_payee_select" ON "PayeeRecovery"
  FOR SELECT TO public
  USING (app.current_user_id() IS NOT NULL AND "payee_user_id" = app.current_user_id());

ALTER TABLE "PayoutAdjustmentNotice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PayoutAdjustmentNotice" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "payout_adjustment_notice_service_role_all" ON "PayoutAdjustmentNotice";
CREATE POLICY "payout_adjustment_notice_service_role_all" ON "PayoutAdjustmentNotice"
  AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "payout_adjustment_notice_owner_all" ON "PayoutAdjustmentNotice";
CREATE POLICY "payout_adjustment_notice_owner_all" ON "PayoutAdjustmentNotice"
  FOR ALL TO public USING (app.is_owner()) WITH CHECK (app.is_owner());
DROP POLICY IF EXISTS "payout_adjustment_notice_payee_select" ON "PayoutAdjustmentNotice";
CREATE POLICY "payout_adjustment_notice_payee_select" ON "PayoutAdjustmentNotice"
  FOR SELECT TO public
  USING (app.current_user_id() IS NOT NULL AND "payee_user_id" = app.current_user_id());

COMMIT;
