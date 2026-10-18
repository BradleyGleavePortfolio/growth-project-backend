-- C4-NOTICE (owner Option 1): each coach sets how many hours before the start
-- a client's own move or cancel locks. Additive. The default of 24 hours
-- matches the lock older app builds already show, so a coach who never edits
-- it gets one consistent rule; 0 means "until the start".
ALTER TABLE "CoachProfile" ADD COLUMN IF NOT EXISTS "booking_cancel_notice_hours" INTEGER NOT NULL DEFAULT 24;
