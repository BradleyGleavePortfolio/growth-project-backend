-- 20270502009900_plan_renewal_offers_opt_in (STORE-B2, agent 184; App Store guideline 4.5.4): the person's
-- yes in the app to plan renewal offers (the Day 1 and Day 7 app notifications after a plan ends).
--
-- NotificationPreferences.plan_renewal_offers_opt_in_at: when the person turned "Plan renewal offers" on in
-- Settings > Notifications. NULL = no. Additive only: one nullable column, no default, no backfill and no
-- data rewrite, so every existing and new account starts at no and the offers stop for everyone until the
-- person says yes. plan_renewal_push and every other column keep their defaults and values (plan_renewal_push
-- now governs only the Day 0 notice that the plan ended).
-- No RLS change: the table keeps its existing row-level policies, which cover every column.
-- Reverse: down.sql.

SET lock_timeout = '5s';

ALTER TABLE "NotificationPreferences" ADD COLUMN IF NOT EXISTS "plan_renewal_offers_opt_in_at" TIMESTAMP(3);

RESET lock_timeout;
