-- Drop dead column `coach_direct_enabled` per R24 (dead code dies with consumer).
-- Added by 20260609000000_add_coach_direct_enabled but never read on the send
-- path: the runtime Coach Messages gate consults `message_push` /
-- `message_inapp` via _kindToPrefsPrefix (MESSAGE_RECEIVED → 'message').
-- No emitter, controller, or service consumed `coach_direct_enabled`, so the
-- column is removed along with the DTO field and service mapping.
ALTER TABLE "NotificationPreferences" DROP COLUMN IF EXISTS "coach_direct_enabled";
