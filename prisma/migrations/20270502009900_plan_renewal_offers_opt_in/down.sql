-- Down for 20270502009900_plan_renewal_offers_opt_in (STORE-B2). Drops the renewal offers yes column.
-- Irreversible for data: every stored yes is deleted (offers stop for everyone); preferences otherwise stay.

SET lock_timeout = '5s';

ALTER TABLE "NotificationPreferences" DROP COLUMN IF EXISTS "plan_renewal_offers_opt_in_at";

RESET lock_timeout;
