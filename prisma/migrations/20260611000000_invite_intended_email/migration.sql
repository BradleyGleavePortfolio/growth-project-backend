-- Add intended_email + acceptance tracking to InviteCode
-- This allows bulk invites to be bound to the intended recipient's email
-- and validates on redemption that the redeeming user matches.

ALTER TABLE "InviteCode" ADD COLUMN IF NOT EXISTS "intended_email" TEXT;
ALTER TABLE "InviteCode" ADD COLUMN IF NOT EXISTS "accepted_by_user_id" TEXT;
ALTER TABLE "InviteCode" ADD COLUMN IF NOT EXISTS "accepted_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "InviteCode_intended_email_idx" 
  ON "InviteCode" (LOWER("intended_email"));
