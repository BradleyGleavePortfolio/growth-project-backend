-- B-RECUR (agent 113, OR-113-1 / OR-113-2) — native subscription checkout.
--
-- Additive only: two nullable columns on ClientPurchase, no backfill, no
-- index or RLS change (ClientPurchase policies are row-scoped and cover every
-- column). Existing rows keep NULL = "no trial was granted on this purchase".
--   trial_days       trial length the checkout offered (NULL = no trial)
--   trial_started_at when the webhook granted the trial's entitlement
--
-- trial_days is SHARED with lane B-TRIALS (#656, 20270228000000), which adds
-- the same nullable INTEGER column with ADD COLUMN IF NOT EXISTS and no CHECK.
-- IF NOT EXISTS here too, so the two migrations apply in either order
-- (fresh database: this file sorts first; production: whichever deploys
-- first creates it). #656 only ever writes 1..30 into it, inside this CHECK.
--
-- Rollback: down.sql (drops the trial_started_at column and the CHECK; drops
-- trial_days only while #656's PackageTrialUsage table does not exist).

BEGIN;

ALTER TABLE "ClientPurchase" ADD COLUMN IF NOT EXISTS "trial_days" INTEGER;
ALTER TABLE "ClientPurchase" ADD COLUMN "trial_started_at" TIMESTAMP(3);

ALTER TABLE "ClientPurchase"
  ADD CONSTRAINT "ClientPurchase_trial_days_range"
  CHECK ("trial_days" IS NULL OR ("trial_days" >= 1 AND "trial_days" <= 730));

COMMIT;
