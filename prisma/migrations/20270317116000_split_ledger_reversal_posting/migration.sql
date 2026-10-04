-- B-CM1-116 (B-674-3, B-676-1). Additive. One immutable row per reversal
-- event and slice. No user id or free text (deletion manifest unchanged); no
-- backfill (legacy reversals keep the old split). Server-only, RLS deny-all.
CREATE TABLE IF NOT EXISTS "SplitLedgerReversal" (
    "id" TEXT NOT NULL,
    "entry_id" TEXT NOT NULL,
    "source_kind" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "cents" INTEGER NOT NULL,
    "posted_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SplitLedgerReversal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SplitLedgerReversal_posted_at_idx" ON "SplitLedgerReversal"("posted_at");

CREATE UNIQUE INDEX IF NOT EXISTS "SplitLedgerReversal_entry_id_source_kind_source_id_key" ON "SplitLedgerReversal"("entry_id", "source_kind", "source_id");

ALTER TABLE "SplitLedgerReversal" ADD CONSTRAINT "SplitLedgerReversal_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "SplitLedgerEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SplitLedgerReversal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SplitLedgerReversal" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SplitLedgerReversal_server_only" ON "SplitLedgerReversal";
CREATE POLICY "SplitLedgerReversal_server_only" ON "SplitLedgerReversal"
    FOR ALL USING (false);

-- ChargeRefund.transfer_reversal_amount_cents: the amount the first head-coach
-- reversal attempt sent; every resend under the same Stripe key replays it.
ALTER TABLE "ChargeRefund" ADD COLUMN IF NOT EXISTS "transfer_reversal_amount_cents" INTEGER;

-- B-674-5 / B-674-10 (B-CM-117): a lost chargeback's head-coach transfer
-- reversal, once. Nullable, no backfill: a chargeback closed earlier has no
-- stamped attempt, so nothing retries it.
ALTER TABLE "ChargeDispute" ADD COLUMN IF NOT EXISTS "transfer_reversal_amount_cents" INTEGER;
ALTER TABLE "ChargeDispute" ADD COLUMN IF NOT EXISTS "transfer_reversal_first_attempt_at" TIMESTAMP(3);
ALTER TABLE "ChargeDispute" ADD COLUMN IF NOT EXISTS "transfer_reversed_at" TIMESTAMP(3);
ALTER TABLE "ChargeDispute" ADD COLUMN IF NOT EXISTS "transfer_reversal_stripe_id" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "ChargeDispute_transfer_reversal_stripe_id_key" ON "ChargeDispute"("transfer_reversal_stripe_id");
