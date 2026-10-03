-- B-COACH-5 (backend #641, B-641-7 / B-641-8) — head-coach transfer reversal
-- retry admission and operator review.
--
-- transfer_reversal_first_attempt_at: the first time a reversal for this
-- refund was (or may have been) sent to Stripe under the refund-scoped
-- idempotency key. Stripe keeps a key for 24 hours from its first request, so
-- every caller (webhooks, the admin refund, the retry sweep) may resend only
-- while this is under 23 hours old.
-- transfer_reversal_review_at: set once when a reversal is still owed past that
-- window; the row leaves automatic retry and an operator reconciles it.
-- transfer_reversal_last_attempt_at (B-641-8): the latest admitted attempt; the
-- retry sweep takes never-attempted rows first, then the least recently
-- attempted, so persistent failures never hold later refunds back.
-- transfer_reversal_stripe_id (B-641-9): the Stripe reversal (trr_...) an owner
-- reconcile recorded for this refund; unique, so one Stripe reversal settles at
-- most one refund. An id, not free text.
--
-- Additive and nullable; no RLS change (ChargeRefund policies are row-level and
-- cover every column). No user id, email or free text is added, so the #608
-- deletion manifest is unchanged (ChargeRefund rows follow their purchase).
--
-- Backfill (conservative): a refund whose books are reversed but whose
-- head-coach transfer is still owed may already have reached Stripe at its
-- first success, so its first attempt is taken to be that time. Rows older
-- than the window then go to operator review instead of being resent.
ALTER TABLE "ChargeRefund" ADD COLUMN IF NOT EXISTS "transfer_reversal_first_attempt_at" TIMESTAMP(3);
ALTER TABLE "ChargeRefund" ADD COLUMN IF NOT EXISTS "transfer_reversal_review_at" TIMESTAMP(3);
ALTER TABLE "ChargeRefund" ADD COLUMN IF NOT EXISTS "transfer_reversal_last_attempt_at" TIMESTAMP(3);
ALTER TABLE "ChargeRefund" ADD COLUMN IF NOT EXISTS "transfer_reversal_stripe_id" TEXT;

UPDATE "ChargeRefund"
SET "transfer_reversal_first_attempt_at" = COALESCE("posted_at", "created_at")
WHERE "ledger_reversed" = true
  AND "transfer_reversed" = false
  AND "transfer_reversal_first_attempt_at" IS NULL;

CREATE INDEX IF NOT EXISTS "ChargeRefund_transfer_reversed_transfer_reversal_review_at_idx"
    ON "ChargeRefund"("transfer_reversed", "transfer_reversal_review_at");

CREATE UNIQUE INDEX IF NOT EXISTS "ChargeRefund_transfer_reversal_stripe_id_key"
    ON "ChargeRefund"("transfer_reversal_stripe_id");
