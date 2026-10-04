-- Reverse of 20270313000000_package_trial_truth. Drops only what migration.sql
-- adds. Owed trial-conflict cancellations and notice leases are lost; run the
-- 20270228000000 down.sql afterwards to remove the trial tables themselves.
SET lock_timeout = '5s';
DROP TABLE IF EXISTS "PackageTrialConflict";
ALTER TABLE "PackageTrialNotice" DROP CONSTRAINT IF EXISTS "PackageTrialNotice_push_status_check";
UPDATE "PackageTrialNotice" SET "push_status" = 'failed' WHERE "push_status" IN ('suppressed', 'skipped');
ALTER TABLE "PackageTrialNotice"
    ADD CONSTRAINT "PackageTrialNotice_push_status_check"
    CHECK ("push_status" IN ('pending', 'delivered', 'no_token', 'failed'));
ALTER TABLE "PackageTrialNotice" DROP CONSTRAINT IF EXISTS "PackageTrialNotice_email_status_check";
UPDATE "PackageTrialNotice" SET "email_status" = 'failed' WHERE "email_status" = 'skipped';
ALTER TABLE "PackageTrialNotice"
    ADD CONSTRAINT "PackageTrialNotice_email_status_check"
    CHECK ("email_status" IN ('pending', 'sent', 'no_email', 'failed'));
ALTER TABLE "PackageTrialNotice" DROP COLUMN IF EXISTS "tax_may_apply";
ALTER TABLE "PackageTrialNotice" DROP CONSTRAINT IF EXISTS "PackageTrialNotice_source_check";
ALTER TABLE "PackageTrialNotice" DROP COLUMN IF EXISTS "email_lease_until";
ALTER TABLE "PackageTrialNotice" DROP COLUMN IF EXISTS "email_lease_token";
ALTER TABLE "PackageTrialNotice" DROP COLUMN IF EXISTS "push_lease_until";
ALTER TABLE "PackageTrialNotice" DROP COLUMN IF EXISTS "push_lease_token";
ALTER TABLE "PackageTrialNotice" DROP COLUMN IF EXISTS "source";
UPDATE "PackageTrialNotice" SET "stripe_event_id" = 'reconciled' WHERE "stripe_event_id" IS NULL;
ALTER TABLE "PackageTrialNotice" ALTER COLUMN "stripe_event_id" SET NOT NULL;
DROP INDEX IF EXISTS "ClientPurchase_status_trial_ends_at_idx";
ALTER TABLE "ClientPurchase" DROP COLUMN IF EXISTS "card_on_file";
RESET lock_timeout;
