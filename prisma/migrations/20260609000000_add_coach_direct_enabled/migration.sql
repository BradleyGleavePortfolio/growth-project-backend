-- AlterTable
ALTER TABLE "NotificationPreferences" ADD COLUMN IF NOT EXISTS "coach_direct_enabled" BOOLEAN NOT NULL DEFAULT true;
