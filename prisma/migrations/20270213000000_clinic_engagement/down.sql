-- Down for 20270213000000_clinic_engagement. Drops scheduler state only
-- (welcome jobs, per-coach welcome settings, reminder ledger) and the two
-- workout-reminder preference columns, and the CoachMessage welcome_job_id key
-- (NULL on every non-welcome row; the welcome rows themselves are kept).
DROP TABLE IF EXISTS "WorkoutReminderDelivery";
DROP TABLE IF EXISTS "CoachWelcomeMessageJob";
DROP TABLE IF EXISTS "CoachWelcomeMessageSetting";
ALTER TABLE "NotificationPreferences" DROP COLUMN IF EXISTS "workout_reminder_push";
ALTER TABLE "NotificationPreferences" DROP COLUMN IF EXISTS "workout_reminder_inapp";
DROP INDEX IF EXISTS "CoachMessage_welcome_job_id_key";
ALTER TABLE "CoachMessage" DROP COLUMN IF EXISTS "welcome_job_id";
