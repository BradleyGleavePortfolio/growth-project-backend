-- Down for 20270203000000_clinic_engagement. Drops scheduler state only
-- (welcome jobs, per-coach welcome settings, reminder ledger) and the two
-- workout-reminder preference columns.
DROP TABLE IF EXISTS "WorkoutReminderDelivery";
DROP TABLE IF EXISTS "CoachWelcomeMessageJob";
DROP TABLE IF EXISTS "CoachWelcomeMessageSetting";
ALTER TABLE "NotificationPreferences" DROP COLUMN IF EXISTS "workout_reminder_push";
ALTER TABLE "NotificationPreferences" DROP COLUMN IF EXISTS "workout_reminder_inapp";
