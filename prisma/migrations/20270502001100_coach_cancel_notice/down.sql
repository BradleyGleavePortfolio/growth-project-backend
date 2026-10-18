-- Reverse of 20270502001100_coach_cancel_notice (drops only what it added).
ALTER TABLE "CoachProfile" DROP COLUMN IF EXISTS "booking_cancel_notice_hours";
