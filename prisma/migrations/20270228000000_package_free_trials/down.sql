-- Reverse of 20270228000000_package_free_trials. Drops only what migration.sql
-- creates. Trial reservations and notices written after the migration are lost.
SET lock_timeout = '5s';
DROP TABLE IF EXISTS "PackageTrialNotice";
DROP TABLE IF EXISTS "PackageTrialUsage";
ALTER TABLE "ClientPurchase" DROP CONSTRAINT IF EXISTS "ClientPurchase_trial_days_check";
ALTER TABLE "ClientPurchase" DROP COLUMN IF EXISTS "trial_ends_at", DROP COLUMN IF EXISTS "trial_days";
ALTER TABLE "CoachPackage" DROP CONSTRAINT IF EXISTS "CoachPackage_trial_days_check";
ALTER TABLE "CoachPackage" DROP COLUMN IF EXISTS "trial_days";
RESET lock_timeout;
