-- Reverse of 20270317116000_split_ledger_reversal_posting (drops only what it added).
DROP TABLE IF EXISTS "SplitLedgerReversal";
ALTER TABLE "ChargeRefund" DROP COLUMN IF EXISTS "transfer_reversal_amount_cents";
DROP INDEX IF EXISTS "ChargeDispute_transfer_reversal_stripe_id_key";
ALTER TABLE "ChargeDispute" DROP COLUMN IF EXISTS "transfer_reversal_last_attempt_at";
ALTER TABLE "ChargeDispute" DROP COLUMN IF EXISTS "transfer_reversal_stripe_id";
ALTER TABLE "ChargeDispute" DROP COLUMN IF EXISTS "transfer_reversed_at";
ALTER TABLE "ChargeDispute" DROP COLUMN IF EXISTS "transfer_reversal_first_attempt_at";
ALTER TABLE "ChargeDispute" DROP COLUMN IF EXISTS "transfer_reversal_amount_cents";
