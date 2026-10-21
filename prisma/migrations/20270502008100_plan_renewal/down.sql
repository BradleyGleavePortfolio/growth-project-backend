-- Down for 20270502008100_plan_renewal (RENEWAL-BE). Drops the table (its
-- policies go with it) and the two switch columns. Irreversible for data:
-- every renewal sequence row and both switches' values are deleted; purchases,
-- preferences and coach settings otherwise stay.

SET lock_timeout = '5s';

DROP TABLE IF EXISTS "PlanRenewal";
ALTER TABLE "NotificationPreferences" DROP COLUMN IF EXISTS "plan_renewal_push";
ALTER TABLE "CoachWelcomeMessageSetting" DROP COLUMN IF EXISTS "renewal_messages_enabled";

RESET lock_timeout;
