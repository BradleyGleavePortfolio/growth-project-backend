-- Down for 20270502008100_plan_renewal (RENEWAL-BE). Drops the table (its
-- policies go with it) and the client's switch column. Irreversible for data:
-- every renewal sequence row and the switch's values are deleted; purchases
-- and preferences otherwise stay.

SET lock_timeout = '5s';

DROP TABLE IF EXISTS "PlanRenewal";
ALTER TABLE "NotificationPreferences" DROP COLUMN IF EXISTS "plan_renewal_push";

RESET lock_timeout;
