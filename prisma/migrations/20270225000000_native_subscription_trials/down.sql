-- Reverse of 20270225000000_native_subscription_trials.
-- Drops trial bookkeeping only; purchases, subscriptions and entitlement are
-- untouched. After a rollback the one-trial-per-coach rule cannot see past
-- trials, so roll back only before trials are switched on for packages.
BEGIN;

ALTER TABLE "ClientPurchase" DROP CONSTRAINT IF EXISTS "ClientPurchase_trial_days_range";
ALTER TABLE "ClientPurchase" DROP COLUMN IF EXISTS "trial_days";
ALTER TABLE "ClientPurchase" DROP COLUMN IF EXISTS "trial_started_at";

COMMIT;
