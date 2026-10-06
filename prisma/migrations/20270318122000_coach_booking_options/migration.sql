-- S-AVAIL-122: coach booking options (minimum notice, booking window,
-- buffers, optional daily maximum). Additive. The defaults reproduce the fixed
-- rules every coach had before (5 minutes notice, 120 days ahead, no buffers,
-- no daily cap), so existing coaches see no change until they edit them.
ALTER TABLE "CoachProfile" ADD COLUMN IF NOT EXISTS "booking_min_notice_minutes" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "CoachProfile" ADD COLUMN IF NOT EXISTS "booking_window_days" INTEGER NOT NULL DEFAULT 120;
ALTER TABLE "CoachProfile" ADD COLUMN IF NOT EXISTS "booking_buffer_before_min" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CoachProfile" ADD COLUMN IF NOT EXISTS "booking_buffer_after_min" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CoachProfile" ADD COLUMN IF NOT EXISTS "booking_daily_max" INTEGER;
