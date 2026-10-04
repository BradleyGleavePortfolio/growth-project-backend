-- Reverse of 20270228000000_package_free_trials. Drops only what migration.sql
-- creates. Trial reservations and notices written after the migration are lost.
SET lock_timeout = '5s';
DROP TABLE IF EXISTS "PackageTrialNotice";
DROP TABLE IF EXISTS "PackageTrialUsage";
-- ClientPurchase.trial_days is shared with B-RECUR (20270225000000) and is
-- left in place; dropping it here would break their checkout.
ALTER TABLE "ClientPurchase" DROP COLUMN IF EXISTS "trial_ends_at";
ALTER TABLE "CoachPackage" DROP CONSTRAINT IF EXISTS "CoachPackage_trial_days_check";
ALTER TABLE "CoachPackage" DROP COLUMN IF EXISTS "trial_days";
RESET lock_timeout;
