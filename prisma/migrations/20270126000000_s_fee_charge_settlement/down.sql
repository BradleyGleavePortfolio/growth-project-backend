-- Reverse of 20270126000000_s_fee_charge_settlement.
-- Disposable/pre-use only: refuses once any ChargeSettlement or PayeeRecovery
-- row exists (those rows are money records; repair is forward-only). Never
-- claims to restore data.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL row_security = off;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ChargeSettlement") OR EXISTS (SELECT 1 FROM "PayeeRecovery") THEN
    RAISE EXCEPTION 'S-FEE down refused: settlement rows exist; fix forward';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "SplitLedgerEntry"
    GROUP BY "purchase_id", "kind", "payee_user_id"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'S-FEE down refused: per-charge ledger rows exist; the old per-purchase unique cannot be restored';
  END IF;
END $$;

ALTER TABLE "ConnectTransfer" DROP CONSTRAINT IF EXISTS "ConnectTransfer_settlement_id_fkey";
DROP INDEX IF EXISTS "ConnectTransfer_settlement_id_idx";
DROP TABLE "PayeeRecovery";
DROP TABLE "ChargeSettlement";
ALTER TABLE "ConnectTransfer" DROP COLUMN "netted_recovery_cents";
ALTER TABLE "ConnectTransfer" DROP COLUMN "kind";
ALTER TABLE "ConnectTransfer" DROP COLUMN "settlement_id";
DROP INDEX IF EXISTS "SplitLedgerEntry_stripe_charge_id_idx";
DROP INDEX IF EXISTS "SplitLedgerEntry_purchase_kind_payee_charge_key";
-- Restore the migration chain's original name for the 3-column unique.
CREATE UNIQUE INDEX "SplitLedgerEntry_purchase_kind_payee_idx"
  ON "SplitLedgerEntry"("purchase_id", "kind", "payee_user_id");

COMMIT;
