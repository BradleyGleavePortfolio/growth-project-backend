-- Reverse of 20270314000000_charge_refund_transfer_reversal_review. Drops only
-- what the forward migration added. After rollback the pre-B-COACH-5 retry
-- sweep (age measured from posted_at) applies again.
DROP INDEX IF EXISTS "ChargeRefund_transfer_reversal_stripe_id_key";
DROP INDEX IF EXISTS "ChargeRefund_transfer_reversed_transfer_reversal_review_at_idx";
ALTER TABLE "ChargeRefund" DROP COLUMN IF EXISTS "transfer_reversal_stripe_id";
ALTER TABLE "ChargeRefund" DROP COLUMN IF EXISTS "transfer_reversal_last_attempt_at";
ALTER TABLE "ChargeRefund" DROP COLUMN IF EXISTS "transfer_reversal_review_at";
ALTER TABLE "ChargeRefund" DROP COLUMN IF EXISTS "transfer_reversal_first_attempt_at";
