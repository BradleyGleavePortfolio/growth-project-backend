-- Reverse of 20270317116000_split_ledger_reversal_posting (drops only what it added).
DROP TABLE IF EXISTS "SplitLedgerReversal";
ALTER TABLE "ChargeRefund" DROP COLUMN IF EXISTS "transfer_reversal_amount_cents";
