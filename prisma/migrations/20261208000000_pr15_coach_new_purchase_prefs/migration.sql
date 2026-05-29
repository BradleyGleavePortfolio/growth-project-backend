-- PR-15A — COACH_NEW_PURCHASE notification preferences columns.
--
-- A new NotificationKind.COACH_NEW_PURCHASE is fired from
-- PurchaseFanoutService.onPurchaseEntitled (PR-9 hook) so the SELLING
-- coach learns about a new buyer the moment entitlement commits.
--
-- The _kindToPrefsPrefix() router in NotificationsService maps
-- kinds whose string starts with 'coach_new_purchase' to the
-- 'coach_new_purchase_*' prefs columns. Without these columns the
-- kind falls through to the 'digest' safe-default whose _push +
-- _inapp defaults are FALSE — the exact PR-10 R1 P2 bug that
-- silently short-circuited every DRIP_RELEASED in-app row write
-- before the prefix branch was added. We add the dedicated prefix
-- + dedicated default-ON push/in-app columns here so coaches DO get
-- pinged on every new purchase by default (decision #9 mirror).
--
-- Defaults: a coach who is SELLING packages wants to know about
-- new purchases. push + in-app default ON. email default OFF
-- because no transactional new-purchase email channel exists today
-- (mirrors the DRIP_RELEASED + booking cluster pattern).
--
-- All three columns are NOT NULL with a static default → metadata-only
-- ALTER + per-row default-fill on existing rows. No backfill script.
ALTER TABLE "NotificationPreferences"
  ADD COLUMN "coach_new_purchase_email" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "NotificationPreferences"
  ADD COLUMN "coach_new_purchase_push" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "NotificationPreferences"
  ADD COLUMN "coach_new_purchase_inapp" BOOLEAN NOT NULL DEFAULT true;
