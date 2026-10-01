-- S-FEE — per-charge settlement ledger for coach-package payments.
--
-- Additive except for one index swap on SplitLedgerEntry:
--   * new tables ChargeSettlement, PayeeRecovery (RLS enabled + forced);
--   * ConnectTransfer gains settlement_id / kind / netted_recovery_cents
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

-- RLS.
ALTER TABLE "ChargeSettlement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChargeSettlement" FORCE ROW LEVEL SECURITY;
ALTER TABLE "PayeeRecovery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PayeeRecovery" FORCE ROW LEVEL SECURITY;

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

COMMIT;
