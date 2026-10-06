-- Reverse of 20270318122000_coach_booking_options (drops only what it added).
ALTER TABLE "CoachProfile" DROP COLUMN IF EXISTS "booking_daily_max";
ALTER TABLE "CoachProfile" DROP COLUMN IF EXISTS "booking_buffer_after_min";
ALTER TABLE "CoachProfile" DROP COLUMN IF EXISTS "booking_buffer_before_min";
ALTER TABLE "CoachProfile" DROP COLUMN IF EXISTS "booking_window_days";
ALTER TABLE "CoachProfile" DROP COLUMN IF EXISTS "booking_min_notice_minutes";
