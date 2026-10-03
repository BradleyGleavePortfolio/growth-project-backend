-- B-RECUR (agent 113, OR-113-1 / OR-113-2) — native subscription checkout.
--
-- Additive only: two nullable columns on ClientPurchase, no backfill, no
-- index or RLS change (ClientPurchase policies are row-scoped and cover every
-- column). Existing rows keep NULL = "no trial was granted on this purchase".
--   trial_days       trial length the checkout offered (NULL = no trial)
--   trial_started_at when the webhook granted the trial's entitlement
--
-- Rollback: down.sql (drops the two columns; only trial bookkeeping is lost).

BEGIN;

ALTER TABLE "ClientPurchase" ADD COLUMN "trial_days" INTEGER;
ALTER TABLE "ClientPurchase" ADD COLUMN "trial_started_at" TIMESTAMP(3);

ALTER TABLE "ClientPurchase"
  ADD CONSTRAINT "ClientPurchase_trial_days_range"
  CHECK ("trial_days" IS NULL OR ("trial_days" >= 1 AND "trial_days" <= 730));

COMMIT;
