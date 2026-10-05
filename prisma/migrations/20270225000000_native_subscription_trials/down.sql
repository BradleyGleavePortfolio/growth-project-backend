-- Reverse of 20270225000000_native_subscription_trials.
-- Drops trial bookkeeping only; purchases, subscriptions and entitlement are
-- untouched. After a rollback the one-trial-per-coach rule cannot see past
-- trials, so roll back only before trials are switched on for packages.
-- ClientPurchase.trial_days is shared with B-TRIALS (#656): it is dropped only
-- when #656's migration has not been applied (no "PackageTrialUsage" table),
-- so rolling this back never removes a column #656 still reads.
BEGIN;

ALTER TABLE "ClientPurchase" DROP CONSTRAINT IF EXISTS "ClientPurchase_trial_days_range";
ALTER TABLE "ClientPurchase" DROP COLUMN IF EXISTS "trial_started_at";
DO $$
BEGIN
  IF to_regclass('public."PackageTrialUsage"') IS NULL THEN
    ALTER TABLE "ClientPurchase" DROP COLUMN IF EXISTS "trial_days";
  END IF;
END
$$;

COMMIT;
